"""Real v1 upgrades and transactional rollback protect existing user records."""
from contextlib import closing
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

from lianban.storage import connect, initialize, initialize_connection
from lianban.storage import migrations
from lianban.storage.settings import get_settings, set_settings
from lianban.storage.shareholders import save_batch
from lianban.storage.transaction import transaction
from lianban.runtime.metadata import MetadataRefresher
from lianban.core.clock import now_iso


class ShareholderUpgradeTests(unittest.TestCase):
    def legacy_v1(self):
        conn = connect(':memory:')
        self.addCleanup(conn.close)
        with transaction(conn):
            migrations._initialize_legacy(conn)
            conn.execute("INSERT INTO stocks VALUES ('000001','测试','深市主板','2026-10-29')")
            conn.execute("INSERT INTO stock_notes VALUES ('000001','保留我的备注',3,'2026-10-28')")
            conn.execute("INSERT INTO stock_note_entries(code,occurred_at,content,updated_at) VALUES ('000001','2026-10-28','历史备注','2026-10-28')")
            conn.execute("INSERT INTO stock_blacklist VALUES ('000001','2026-10-28')")
            conn.execute("INSERT INTO stock_tag_overrides VALUES ('000001','[\"我的标签\"]',2,'2026-10-28')")
        return conn

    def test_v1_upgrade_only_adds_shareholder_schema_and_preserves_personal_tables(self):
        conn = self.legacy_v1()
        tables = ('stocks', 'stock_notes', 'stock_note_entries', 'stock_blacklist', 'stock_tag_overrides', 'settings')
        before = {table: [tuple(row) for row in conn.execute(f'SELECT * FROM {table}')] for table in tables}
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 1)
        with patch.object(migrations, '_initialize_legacy', side_effect=AssertionError('v1 must not rerun legacy migrations')):
            initialize_connection(conn)
            initialize_connection(conn)
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], migrations.SCHEMA_VERSION)
        self.assertEqual({table: [tuple(row) for row in conn.execute(f'SELECT * FROM {table}')] for table in tables}, before)
        self.assertEqual(conn.execute('SELECT COUNT(*) FROM stock_shareholders').fetchone()[0], 0)
        self.assertFalse(conn.in_transaction)

    def test_failed_migration_rolls_back_ddl_and_version_together(self):
        conn = self.legacy_v1()
        with patch.object(migrations, 'SHAREHOLDER_SCHEMA', migrations.SHAREHOLDER_SCHEMA + 'INVALID SQL;'):
            with self.assertRaises(sqlite3.OperationalError):
                initialize_connection(conn)
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 1)
        self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE name='shareholder_profiles'").fetchone())
        initialize_connection(conn)
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], migrations.SCHEMA_VERSION)
        conn.execute(f'PRAGMA user_version={migrations.SCHEMA_VERSION + 1}')
        with self.assertRaisesRegex(ValueError, 'newer'):
            initialize_connection(conn)
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], migrations.SCHEMA_VERSION + 1)

    def test_save_batch_joins_outer_transaction_instead_of_committing_it(self):
        with closing(initialize(':memory:')) as conn:
            row = {'code': '000001', 'holder_key': 'fixture', 'holder_name': '合成股东',
                   'holder_type': '个人', 'report_date': '2026-09-30'}
            with self.assertRaisesRegex(RuntimeError, 'rollback'):
                with transaction(conn):
                    save_batch(conn, ['000001'], {'total': [row], 'float': [row]})
                    set_settings(conn, shareholder_status='current')
                    raise RuntimeError('rollback')
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM shareholder_profiles').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM stock_shareholders').fetchone()[0], 0)
            self.assertNotIn('shareholder_status', get_settings(conn))

    def test_newly_archived_stock_triggers_refresh_even_with_fresh_global_timestamp(self):
        root = Path(__file__).resolve().parents[1] / '.build' / ('shareholder-policy-' + uuid4().hex)
        path = root / 'archive.sqlite3'
        with closing(initialize(path)) as conn:
            conn.execute("INSERT INTO stocks VALUES ('000001','测试','深市主板','2026-10-29')")
            conn.commit()
            set_settings(conn, shareholder_fetched_at=now_iso(), shareholder_requested=0)
        job = MetadataRefresher(path, prefix='shareholder', refresh_callback=lambda _: None)
        self.addCleanup(job.stop)
        with patch('lianban.runtime.metadata.threading.Thread') as thread:
            job.maybe_refresh()
            thread.return_value.start.assert_called_once()
        with closing(connect(path)) as conn:
            self.assertEqual(get_settings(conn)['shareholder_status'], 'updating')
