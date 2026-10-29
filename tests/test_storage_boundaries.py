"""Initialization, migration and use-case atomicity use isolated in-memory databases."""
import sqlite3
import unittest
from unittest.mock import patch

from lianban.storage import connect, initialize, initialize_connection
from lianban.storage.migrations import SCHEMA
from lianban.storage.transaction import transaction
from lianban.storage.settings import get_settings, set_settings
from lianban.research import tags, tag_management
from lianban.archive import service


class StorageBoundariesTests(unittest.TestCase):
    def test_open_is_not_initialization(self):
        with connect(":memory:") as conn:
            self.assertEqual(list(conn.execute("SELECT name FROM sqlite_master WHERE type='table'")), [])
            initialize_connection(conn)
            self.assertIsNotNone(conn.execute("SELECT name FROM sqlite_master WHERE name='events'").fetchone())
            self.assertFalse(conn.in_transaction)
            with patch("lianban.research.tag_management.migrate_detached_names", side_effect=AssertionError("already migrated")):
                initialize_connection(conn)

    def test_legacy_notes_registration_and_names_are_migrated_once(self):
        conn = connect(":memory:")
        self.addCleanup(conn.close)
        conn.executescript(SCHEMA)
        with conn:
            conn.execute("INSERT INTO stocks VALUES ('000001','测试','深市主板','2026-10-29')")
            conn.execute("INSERT INTO stock_notes VALUES ('000001','旧备注',2,'2026-10-28T12:00:00+08:00')")
            conn.execute("INSERT INTO company_registrations VALUES ('000001','广东省','深圳市','旧位置','旧地址','fixture','now')")
            conn.execute("INSERT INTO tag_aliases VALUES ('旧标签','新标签')")
            conn.execute("INSERT INTO stock_tag_overrides VALUES ('000001','[\"旧标签\"]',1,'now')")
        initialize_connection(conn)
        self.assertEqual(conn.execute("SELECT content FROM stock_note_entries").fetchone()[0], '旧备注')
        self.assertEqual(tuple(conn.execute("SELECT city,location,address FROM company_registrations").fetchone()), ('','',''))
        self.assertEqual(tags.get_stock_tags(conn,'000001')['tags'], ['新标签'])
        before = conn.total_changes
        initialize_connection(conn)
        self.assertEqual(conn.total_changes, before)
        self.assertEqual(get_settings(conn)['tag_name_storage'], 'detached-v1')

    def test_failed_initialization_rolls_back_all_schema_and_markers(self):
        conn = connect(":memory:")
        self.addCleanup(conn.close)
        with patch("lianban.research.tag_management.migrate_detached_names", side_effect=RuntimeError("injected")):
            with self.assertRaises(RuntimeError):
                initialize_connection(conn)
        self.assertEqual(list(conn.execute("SELECT name FROM sqlite_master WHERE type='table'")), [])
        initialize_connection(conn)

    def test_outer_use_case_rollback_covers_tags_notes_and_settings(self):
        conn = initialize(":memory:")
        self.addCleanup(conn.close)
        service.save_day(conn,'2026-10-29',[{'code':'000001','name':'测试','boards':1}], 'fixture')
        revision = tag_management.catalog(conn)['revision']
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            with transaction(conn):
                tag_management.save_node(conn, '父标签', '', revision)
                tags.save_stock_tags(conn, '000001', ['父标签'], 0)
                set_settings(conn, rollback_probe=True)
                raise RuntimeError('injected')
        self.assertEqual(tags.get_stock_tags(conn,'000001')['tags'], [])
        self.assertEqual(tag_management.hierarchy(conn), [])
        self.assertNotIn('rollback_probe', get_settings(conn))
        self.assertEqual(tag_management.catalog(conn)['revision'], revision)

    def test_path_use_case_rolls_back_membership_if_hierarchy_save_fails(self):
        conn = initialize(":memory:")
        self.addCleanup(conn.close)
        service.save_day(conn,'2026-10-29',[{'code':'000001','name':'测试','boards':1}], 'fixture')
        with patch.object(tag_management, '_save_hierarchy', side_effect=RuntimeError('injected')):
            with self.assertRaises(RuntimeError):
                tag_management.save_stock_tag_paths(conn,'000001',['父/子'],0)
        self.assertEqual(tags.get_stock_tags(conn,'000001')['revision'], 0)
        self.assertEqual(tag_management.hierarchy(conn), [])


    def test_confirmed_day_wins_when_failure_races_before_writer_lock(self):
        from contextlib import contextmanager
        uri = "file:archive-race?mode=memory&cache=shared"
        first = sqlite3.connect(uri, uri=True)
        second = sqlite3.connect(uri, uri=True)
        self.addCleanup(first.close)
        self.addCleanup(second.close)
        first.row_factory = second.row_factory = sqlite3.Row
        initialize_connection(first)

        @contextmanager
        def successful_writer_wins_lock(conn):
            # Deterministically place the successful writer between entry to
            # the failed save and its lock acquisition, without using sleeps.
            if conn is first:
                service.save_day(second, '2026-10-29', [{'code': '000001', 'name': 'confirmed', 'boards': 1}], 'success')
            with transaction(conn):
                yield conn

        with patch.object(service, 'transaction', successful_writer_wins_lock):
            changed = service.save_day(first, '2026-10-29', [], 'failure', status='failed')
        self.assertFalse(changed)
        self.assertEqual(tuple(first.execute('SELECT status,count,source FROM days').fetchone()), ('ok', 1, 'success'))
        self.assertEqual(first.execute('SELECT COUNT(*) FROM events').fetchone()[0], 1)

    def test_pair_query_reads_candidate_histories_only_for_shared_periods(self):
        from lianban.archive import relationship_queries
        conn = initialize(':memory:')
        self.addCleanup(conn.close)
        def event(code, boards):
            return {'code': code, 'name': 'fixture', 'boards': boards}
        service.save_day(conn, '2026-10-26', [event('000003', 1), event('000004', 1)], 'fixture')
        service.save_day(conn, '2026-10-27', [event('000001', 1), event('000002', 1), event('000004', 2)], 'fixture')
        service.save_day(conn, '2026-10-28', [event('000003', 1), event('000004', 3)], 'fixture')
        service.save_day(conn, '2026-10-29', [event('000004', 4)], 'fixture')
        settings = {'calendar_dates': ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']}
        observed = []
        read = relationship_queries._observations
        def capture(*args, **kwargs):
            rows = read(*args, **kwargs)
            observed.extend(rows)
            return rows
        with patch.object(relationship_queries, '_observations', side_effect=capture):
            result = relationship_queries.stock_pair_comparison(conn, '000001', '000002', '2026-10-27', '2026-10-28', settings)
        self.assertNotIn('000003', {row['code'] for row in observed})
        leader = result['segments'][0]['leader']
        self.assertEqual((leader['code'], leader['start'], leader['end'], leader['max_boards']), ('000004', '2026-10-26', '2026-10-28', 3))
        self.assertNotIn('2026-10-29', {row['date'] for row in observed})
