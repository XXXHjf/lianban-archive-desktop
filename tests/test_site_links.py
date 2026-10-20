"""Public notice links expose only validated display URLs."""
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import app
import database as db


class SiteLinkTests(unittest.TestCase):
    def test_defaults_and_explicit_empty_links(self):
        with closing(db.connect(":memory:")) as conn:
            self.assertEqual(db.get_site_links(conn), {"links": db.DEFAULT_SITE_LINKS})
            db.set_settings(conn, site_links={"author_url": "", "feedback_url": ""})
            self.assertEqual(db.get_site_links(conn), {"links": {"author_url": "", "feedback_url": ""}})

    def test_only_public_fields_are_returned_and_storage_is_unchanged(self):
        with closing(db.connect(":memory:")) as conn:
            saved = {"author_url": "https://example.org/author?a=1&b=2", "feedback_url": "https://example.org/post#comments",
                     "revision": 5, "updated_at": "2026-10-19", "private_field": "not public"}
            db.set_settings(conn, site_links=saved)
            self.assertEqual(db.get_site_links(conn), {"links": {key: saved[key] for key in db.DEFAULT_SITE_LINKS}})
            self.assertEqual(db.get_settings(conn)["site_links"], saved)
            self.assertNotIn("site_links", db.meta(conn), "metadata cannot leak the raw configuration")

    def test_invalid_urls_are_disabled(self):
        for value in (None, [], "javascript:alert(1)", "data:text/html,hi", "//example.org", "https:example.org",
                      "https://", "https://a@host.test", "https://@host.test", "https://host.test:invalid/",
                      "https://host.test/\npath", "https://host.test/a b", "https://host.test\\path", "https://host.test/" + "a" * 2048):
            with self.subTest(value=value), closing(db.connect(":memory:")) as conn:
                db.set_settings(conn, site_links={"author_url": value, "feedback_url": value})
                self.assertEqual(db.get_site_links(conn), {"links": {"author_url": "", "feedback_url": ""}})

    def test_malformed_configuration_uses_initial_defaults(self):
        with closing(db.connect(":memory:")) as conn:
            for value in (None, [], "bad configuration"):
                db.set_settings(conn, site_links=value)
                self.assertEqual(db.get_site_links(conn), {"links": db.DEFAULT_SITE_LINKS})
            conn.execute("UPDATE settings SET value='invalid-json' WHERE key='site_links'")
            self.assertEqual(db.get_site_links(conn), {"links": db.DEFAULT_SITE_LINKS})

    def test_public_route_reads_configuration_without_archive_metadata(self):
        with closing(db.connect(":memory:")) as conn:
            db.set_settings(conn, site_links={"feedback_url": "https://example.org/topic"})
            connect = db.connect
            def connect_copy(_):
                copied = connect(":memory:")
                conn.backup(copied)
                return copied
            with patch.object(app.db, "connect", side_effect=connect_copy), patch.object(app.db, "meta", side_effect=AssertionError("unneeded metadata")):
                result = app.read_api(SimpleNamespace(db_path=":memory:", read_only=True), "/api/site-links")
            self.assertEqual(result["links"], {**db.DEFAULT_SITE_LINKS, "feedback_url": "https://example.org/topic"})


if __name__ == "__main__":
    unittest.main()
