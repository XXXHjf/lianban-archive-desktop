"""Synthetic node evidence: no live market assumptions and no external requests."""
from contextlib import closing
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from lianban.storage import initialize, connect, initialize_connection, migrations
from lianban.storage.settings import set_settings
from lianban.archive.service import save_day
from lianban.interfaces.http.routes import Handler
from lianban.nodes import service, collection
from lianban.nodes.rules import unique_anchor, node_kind
from lianban.intraday import store as minute_store


def stock(code='000001', boards=1):
    return {'code': code, 'name': '合成' + code, 'boards': boards}


class NodeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='ladder-node-'))
        self.path = self.root / 'archive.sqlite3'
        self.conn = initialize(self.path)
        self.addCleanup(self.conn.close)
        set_settings(self.conn, range_start='2025-10-20', range_end='2025-10-27',
                     calendar_dates=['2025-10-20', '2025-10-21', '2025-10-22', '2025-10-23', '2025-10-24', '2025-10-27'])
        self.save('2025-10-20', [stock(), stock('000002')])

    def save(self, day, rows):
        save_day(self.conn, day, rows, 'synthetic')

    def node(self, day='2025-10-20', height=1, name='合成节点'):
        return service.create(self.conn, day, height, name)['id']

    def result(self, day='2025-10-20', identity=None):
        nodes = service.view(self.conn, day)['nodes']
        return next((r for r in nodes if r['id'] == identity), None) if identity else nodes[0]

    def test_unique_highest_and_exact_zero_threshold(self):
        self.assertIsNone(unique_anchor([stock(boards=5), stock('000002', 5)]))
        self.assertEqual(unique_anchor([stock(boards=1)])['code'], '000001')
        for opening in (9, 10):
            self.assertEqual(node_kind(opening, 10), 'low_open')
        self.assertEqual(node_kind(10.01, 10), 'break')
        for opening in (0, float('nan'), float('inf')):
            with self.assertRaises(ValueError): node_kind(opening, 10)

    def test_progressive_survival_and_rebound_never_rejoins(self):
        identity = self.node()
        self.save('2025-10-21', [stock(boards=2), stock('000003', 2)])
        self.save('2025-10-22', [stock('000002', 1)])
        self.save('2025-10-23', [stock(boards=1), stock('000002', 2)])
        self.assertEqual(self.result('2025-10-21')['codes'], ['000001'])
        self.assertEqual(self.result('2025-10-21')['height'], 2)
        self.assertEqual(self.result('2025-10-22')['status'], 'expired')
        self.assertEqual(self.result('2025-10-23')['codes'], [])
        self.assertEqual(len(self.result(identity=identity)['codes']), 2)

    def test_missing_date_blocks_inference_even_if_later_stock_reappears(self):
        self.node()
        self.save('2025-10-22', [stock(boards=3)])
        self.assertEqual(self.result('2025-10-22')['status'], 'pending')
        self.assertEqual(self.result('2025-10-22')['codes'], [])
        self.save('2025-10-21', [stock(boards=2)])
        self.assertEqual(self.result('2025-10-22')['codes'], ['000001'])

    def test_member_and_whole_deletion_are_effective_dated_and_isolated(self):
        first, second = self.node(name='节点甲'), self.node(name='节点乙')
        self.save('2025-10-21', [stock(boards=2), stock('000002', 2)])
        service.remove(self.conn, first, '2025-10-21', '000001')
        self.assertEqual(self.result('2025-10-21', first)['codes'], ['000002'])
        self.assertEqual(self.result('2025-10-21', second)['codes'], ['000001', '000002'])
        past = self.result('2025-10-20', first)
        self.assertEqual(len(past['codes']), 2)
        self.assertTrue(all(m['excluded_from'] is None for m in past['members']))
        service.remove(self.conn, first, '2025-10-21')
        self.assertEqual(self.result('2025-10-21', first)['status'], 'deleted')
        self.assertIsNone(self.result('2025-10-20', first)['deleted_from'])

    def test_weekend_uses_trading_calendar(self):
        self.save('2025-10-24', [stock()])
        self.save('2025-10-27', [stock(boards=2)])
        identity = self.node('2025-10-24')
        self.assertEqual(self.result('2025-10-27', identity)['codes'], ['000001'])

    def test_birth_pool_correction_removes_withdrawn_member(self):
        self.node()
        self.save('2025-10-20', [stock()])
        self.assertEqual(self.result()['codes'], ['000001'])

    def test_auto_high_open_break_and_manual_delete_survives_recompute(self):
        self.save('2025-10-20', [stock('000678', 5), stock()])
        self.save('2025-10-21', [stock('000002'), stock('000003')])
        fetch = Mock(return_value=(10.01, 10, 'fixture', 'fixture.json'))
        self.assertEqual(collection.sync_day(self.path, '2025-10-21', fetcher=fetch)['status'], 'ok')
        result = self.result('2025-10-21')
        self.assertEqual((result['kind'], result['height']), ('break', 1))
        service.remove(self.conn, result['id'], '2025-10-21', '000002')
        collection.sync_day(self.path, '2025-10-21', fetcher=fetch)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(self.result('2025-10-21')['codes'], ['000003'])
        service.remove(self.conn, result['id'], '2025-10-21')
        collection.sync_day(self.path, '2025-10-21', fetcher=fetch)
        self.assertEqual(self.result('2025-10-21')['status'], 'deleted')

    def test_low_open_binds_only_yesterdays_firsts_promoted_today(self):
        self.save('2025-10-20', [stock('000678', 5), stock(), stock('000002', 2)])
        self.save('2025-10-21', [stock(boards=2), stock('000002', 2), stock('000003')])
        collection.sync_day(self.path, '2025-10-21', fetcher=lambda *a: (10, 10, 'fixture', ''))
        result = self.result('2025-10-21')
        self.assertEqual((result['kind'], result['height'], result['codes']), ('low_open', 2, ['000001']))

    def test_tied_anchor_or_still_limit_up_never_requests_quote(self):
        fetch = Mock(side_effect=AssertionError('must not fetch'))
        self.save('2025-10-21', [stock(boards=2)])
        self.assertEqual(collection.sync_day(self.path, '2025-10-21', fetcher=fetch)['status'], 'none')
        self.save('2025-10-20', [stock('000678', 5)])
        self.save('2025-10-21', [stock('000678', 6), stock()])
        self.assertEqual(collection.sync_day(self.path, '2025-10-21', fetcher=fetch)['status'], 'none')
        fetch.assert_not_called()

    def test_quote_failure_is_pending_and_retry_can_complete(self):
        self.save('2025-10-20', [stock('000678', 5)])
        self.save('2025-10-21', [stock()])
        self.assertEqual(collection.sync_day(self.path, '2025-10-21', fetcher=Mock(side_effect=ValueError('missing')))['status'], 'pending')
        self.assertEqual(service.view(self.conn, '2025-10-21')['nodes'], [])
        self.assertEqual(collection.sync_day(self.path, '2025-10-21', fetcher=lambda *a: (11, 10, 'fixture', ''))['status'], 'ok')

    def test_corrected_prior_pool_with_tied_highest_retires_old_auto_node(self):
        self.save('2025-10-20', [stock('000678', 5)])
        self.save('2025-10-21', [stock()])
        collection.sync_day(self.path, '2025-10-21', fetcher=lambda *a: (11, 10, 'fixture', ''))
        self.save('2025-10-20', [stock('000678', 5), stock('000789', 5)])
        collection.sync_day(self.path, '2025-10-21', fetcher=Mock(side_effect=AssertionError('must not fetch')))
        self.assertEqual(self.result('2025-10-21')['status'], 'superseded')
        self.assertEqual(self.result('2025-10-21')['codes'], [])

    def test_cached_opening_uses_auction_not_first_minute_and_rejects_uncorrected_reference(self):
        self.assertIsNone(collection.cached_opening(self.path, '2025-10-21', '000001'))
        self.assertFalse(minute_store.store_path(self.path).exists())
        with closing(minute_store.initialize(minute_store.store_path(self.path))) as conn:
            conn.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)',
                         ('2025-10-21','000001','fixture','partial','fixture','2025-10-21','',10,'[{"time":"09:30","price":9}]'))
            conn.execute('INSERT INTO session_context VALUES (?,?,?,?)', ('2025-10-21','000001','{}','腾讯当日昨收字段'))
            conn.execute('INSERT INTO auctions VALUES (?,?,?,?,?,?,?,?)',
                         ('2025-10-21','000001','match_only','[{"time":"09:25","price":10}]','fixture','fixture','2025-10-21','raw.json'))
            conn.commit()
            self.assertEqual(collection.cached_opening(self.path,'2025-10-21','000001')[:2], (10,10))
            conn.execute("UPDATE session_context SET reference_basis='前交易日分时收盘参考（未校正除权）'")
            conn.commit()
            self.assertIsNone(collection.cached_opening(self.path,'2025-10-21','000001'))

    def test_wrong_day_daily_quote_and_non_finite_values_rejected(self):
        payload = {'rc': 0, 'data': {'code': '000001', 'klines': ['2025-10-21,10.1,10.2,10.3,9.9,10,100,1,2,0.2,1']}}
        self.assertEqual(collection.daily_opening(payload, '2025-10-21', '000001'), (10.1, 10))
        for day, code in [('2025-10-20', '000001'), ('2025-10-21', '000002')]:
            with self.assertRaises(ValueError): collection.daily_opening(payload, day, code)

    def test_v2_upgrade_preserves_notes_and_failed_ddl_rolls_back(self):
        with closing(connect(':memory:')) as conn:
            migrations._initialize_legacy(conn)
            for statement in migrations.SHAREHOLDER_SCHEMA.split(';'):
                if statement.strip(): conn.execute(statement)
            conn.execute('PRAGMA user_version=2')
            conn.execute("INSERT INTO stock_notes VALUES ('000001','保留',4,'2025-10-20')")
            conn.commit()
            with patch.object(migrations, 'NODE_SCHEMA', migrations.NODE_SCHEMA + 'INVALID SQL;'):
                with self.assertRaises(sqlite3.OperationalError): initialize_connection(conn)
            self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 2)
            self.assertIsNone(conn.execute("SELECT name FROM sqlite_master WHERE name='cycle_nodes'").fetchone())
            initialize_connection(conn)
            self.assertEqual(conn.execute('SELECT content,revision FROM stock_notes').fetchone()[:], ('保留', 4))

    def test_read_only_http_refuses_node_writes(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.db_path, server.read_only = self.path, True
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            for path in ('/api/ladder-nodes', '/api/ladder-nodes/identify'):
                conn = http.client.HTTPConnection(*server.server_address)
                conn.request('POST', path, '{}', {'Content-Type': 'application/json'})
                self.assertEqual(conn.getresponse().status, 403)
                conn.close()
        finally:
            server.shutdown(); server.server_close(); worker.join(2)


if __name__ == '__main__':
    unittest.main()
