"""Assembly contracts: isolated databases, explicit job policy, no network access."""
from contextlib import closing
from pathlib import Path
from uuid import uuid4
import sqlite3
import http.client
import threading
import unittest
from unittest.mock import patch

import app
import concept_tags
import industry
import registration
import suspension
from lianban.config import AppPaths
from lianban.profiles import concepts as concepts_impl
from lianban.profiles import industry as industry_impl
from lianban.profiles import registration as registration_impl
from lianban.profiles import suspension as suspension_impl
from lianban.profiles import shareholders as shareholders_impl
from lianban.runtime.archive_task import ArchiveRefresher
from lianban.runtime.server import DisabledTask


class RuntimeAssemblyTests(unittest.TestCase):
    def setUp(self):
        # Keep synthetic artifacts in ignored build space; never use installed data.
        self.root = Path(__file__).resolve().parents[1] / ".build" / ("runtime-" + uuid4().hex)
        self.root.mkdir(parents=True)
        self.db_path = self.root / "archive.sqlite3"

    def create(self, **kwargs):
        server = app.create_server(self.db_path, 0, **kwargs)
        self.addCleanup(server.server_close)
        self.addCleanup(server.stop_tasks)
        return server

    def test_default_server_builds_all_jobs_without_starting_them(self):
        with patch("threading.Thread") as thread:
            server = self.create()
        thread.assert_not_called()
        self.assertIsInstance(server.archive_refresher, ArchiveRefresher)
        self.assertIsInstance(server.concept_refresher, concepts_impl.Refresher)
        self.assertIsInstance(server.shareholder_refresher, shareholders_impl.Refresher)
        self.assertIsNone(server.shareholder_refresher._thread)
        self.assertFalse(server._tasks_started)
        self.assertIsNone(server.archive_refresher._thread)
        self.assertIsNone(server.live_refresher._thread)
        self.assertIsNone(server.industry_refresher._thread)

    def test_offline_policy_disables_every_data_job_and_can_start_and_stop(self):
        server = self.create(no_updates=True)
        tasks = [server.industry_refresher, server.registration_refresher,
                 server.concept_refresher, server.suspension_refresher,
                 server.archive_refresher, server.live_refresher, server.shareholder_refresher]
        self.assertTrue(all(isinstance(task, DisabledTask) for task in tasks))
        with patch("threading.Thread") as thread:
            server.start_tasks()
            server.start_tasks()
            server.stop_tasks()
        thread.assert_not_called()
        self.assertTrue(server._tasks_started)

    def test_desktop_concept_policy_is_per_server_and_preserves_module_types(self):
        modules = [industry, registration, concept_tags, suspension,
                   industry_impl, registration_impl, concepts_impl, suspension_impl]
        old_types = [module.Refresher for module in modules]
        old_handler = app.Handler
        desktop_server = self.create(include_concepts=False)
        self.assertIsInstance(desktop_server.concept_refresher, DisabledTask)
        self.assertIsInstance(desktop_server.industry_refresher, industry_impl.Refresher)
        ordinary_server = self.create()
        self.assertIsInstance(ordinary_server.concept_refresher, concepts_impl.Refresher)
        self.assertIs(app.Handler, old_handler)
        self.assertEqual([module.Refresher for module in modules], old_types)

    def test_both_databases_are_initialized_and_server_closes_its_socket(self):
        server = self.create(no_updates=True)
        paths = AppPaths.from_archive(self.db_path)
        for path, table in ((paths.archive_db, "days"), (paths.intraday_db, "sessions")):
            self.assertTrue(path.is_file())
            with closing(sqlite3.connect(path)) as conn:
                tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertIn(table, tables)
                # Assembly left no write transaction or initialization connection open.
                conn.execute("BEGIN EXCLUSIVE")
                conn.rollback()
        server.stop_tasks()
        server.server_close()
        self.assertEqual(server.socket.fileno(), -1)


    def test_http_serves_only_real_bundled_assets_with_correct_mime(self):
        class QuietHandler(app.Handler):
            def log_message(self, *args):
                pass
        server = self.create(no_updates=True, handler_class=QuietHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 2)
        self.addCleanup(server.shutdown)

        def request(path):
            client = http.client.HTTPConnection(*server.server_address, timeout=3)
            try:
                client.request("GET", path)
                response = client.getresponse()
                return response.status, response.getheader("Content-Type"), response.read()
            finally:
                client.close()

        web = Path(__file__).resolve().parents[1] / "web"
        assets = [web / 'app.js', *sorted((web / 'assets').glob('*.js')), *sorted((web / 'assets').glob('*.css'))]
        self.assertGreater(len(assets), 3)
        for asset in assets:
            with self.subTest(asset=asset.name):
                status, content_type, body = request("/" + asset.relative_to(web).as_posix() + "?v=test")
                self.assertEqual(status, 200)
                allowed = ('text/css',) if asset.suffix == '.css' else ('text/javascript', 'application/javascript')
                self.assertIn(content_type.split(';', 1)[0], allowed)
                self.assertEqual(body, asset.read_bytes())
        for path in ("/assets/../realtime.js", "/assets/%2e%2e/realtime.js",
                     "/assets/%2e%2e/%2e%2e/app.py", "/assets/..%5crealtime.js",
                     "/assets/missing.js", "/assets/application.txt", "/realtime.js",
                     "/src/main.ts", "/frontend/package.json", "/modules/application.mjs",
                     "/SOURCE_BASELINE.json"):
            with self.subTest(path=path):
                status, _, body = request(path)
                self.assertEqual(status, 404)
                self.assertNotEqual(body, (web / 'app.js').read_bytes())


if __name__ == "__main__":
    unittest.main()
