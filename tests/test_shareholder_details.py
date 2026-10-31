"""Approved detail fields and explicit migrations preserve local matching semantics."""
from contextlib import closing
from datetime import datetime
import gzip
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch
from uuid import uuid4

import database as db
from lianban.profiles import shareholders, shareholder_seed
from lianban.readside import shareholders as queries
from lianban.storage import connect, initialize, initialize_connection, migrations
from lianban.storage.shareholders import save_batch
from lianban.storage.transaction import transaction
from lianban.runtime.metadata import MetadataRefresher
from lianban.core.clock import now_iso


class ShareholderDetailTests(unittest.TestCase):
    def setUp(self):
        self.conn = initialize(':memory:')
        self.addCleanup(self.conn.close)
        db.save_day(self.conn, '2026-10-30', [
            {'code': code, 'name': code, 'boards': 1} for code in ('000001', '000002', '000003')], 'synthetic')
        self.now = datetime(2026, 10, 30, 16, tzinfo=db.TZ)

    def row(self, code, name, ratio=None, kind='个人'):
        return {'code': code, 'holder_key': name, 'holder_name': name, 'holder_type': kind,
                'report_date': '2026-09-30', 'holding_ratio': ratio}

    def test_scoped_ratios_zero_unknown_and_controls_never_add_relationships(self):
        rows = [self.row('000001', '未知'), self.row('000001', '零', 0), self.row('000001', '合成机构', 10.12345)]
        save_batch(self.conn, ['000001'], {'total': rows, 'float': [self.row('000001', '合成机构', 19.1)]})
        with transaction(self.conn):
            for code in ('000001', '000002'):
                self.conn.execute('INSERT INTO stock_control_profiles VALUES (?,?,?)', (code, 'synthetic', now_iso()))
                self.conn.execute('INSERT INTO stock_control_owners VALUES (?,?,?,?,?,?,?,?)',
                                  (code, 'controller', '同一控制人', '同一控制人', '个人', '', 'https://emweb.securities.eastmoney.com/', now_iso()))
        result = queries.stock_view(self.conn, '000001', now=self.now)
        self.assertEqual(result['rows'], [], 'control-only links must never become shared shareholders')
        self.assertEqual(queries.today_alerts(self.conn, now=self.now)['rows'], [])
        self.assertEqual([r['holding_ratio'] for r in result['own_holders']['total']], [10.12345, 0, None])
        self.assertEqual(result['own_holders']['float'][0]['holding_ratio'], 19.1)
        self.assertEqual(result['control_owners'][0]['kind'], 'controller')
        self.assertTrue(result['control_checked'])

    def test_conflicting_categories_use_total_precedence_in_list_and_alert(self):
        for code in ('000001', '000002'):
            save_batch(self.conn, [code], {'total': [self.row(code, '同名', kind='基金')],
                                          'float': [self.row(code, '同名', kind='个人')]})
        view = queries.stock_view(self.conn, '000001', now=self.now)
        self.assertEqual(view['rows'][0]['holders'][0]['type'], '基金')
        alerts = queries.today_alerts(self.conn, now=self.now)['rows']
        self.assertEqual(alerts, [{'code': '000001', 'types': ['基金']}, {'code': '000002', 'types': ['基金']}])

    def test_source_denominators_null_zero_and_invalid_ratios(self):
        row = {'SECUCODE': '000001.SZ', 'SECURITY_CODE': '000001', 'END_DATE': '2026-09-30',
               'HOLDER_NAME': '合成股东', 'HOLD_RATIO': 10.1234, 'FREE_HOLDNUM_RATIO': 20.5678}
        def normalized(value, scope):
            payload = {'success': True, 'result': {'pages': 1, 'count': 1, 'data': [value]}}
            return shareholders.normalize_rows(payload, {'000001'}, '2026-10-30', scope)[0][0]
        self.assertEqual(normalized(row, 'total')['holding_ratio'], 10.1234)
        self.assertEqual(normalized(row, 'float')['holding_ratio'], 20.5678)
        for value in (None, 0):
            self.assertEqual(normalized({**row, 'HOLD_RATIO': value}, 'total')['holding_ratio'], value)
        for invalid in (True, -1, 101, float('nan'), float('inf'), 'bad'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                normalized({**row, 'HOLD_RATIO': invalid}, 'total')
        with self.assertRaisesRegex(ValueError, '字段缺失'):
            normalized({k: v for k, v in row.items() if k != 'HOLD_RATIO'}, 'total')

    def legacy_v3(self):
        conn = initialize(':memory:')
        self.addCleanup(conn.close)
        db.save_day(conn, '2026-10-30', [{'code': '000001', 'name': '合成测试', 'boards': 1}], 'synthetic')
        db.save_stock_note(conn, '000001', '个人备注', 0)
        save_batch(conn, ['000001'], {'total': [self.row('000001', '旧股东', 5)], 'float': []})
        with transaction(conn):
            conn.execute('ALTER TABLE stock_shareholders DROP COLUMN holding_ratio')
            conn.execute('ALTER TABLE shareholder_profiles DROP COLUMN ratio_checked')
            for table in ('stock_control_profiles', 'stock_control_owners', 'subsidiary_profiles'):
                conn.execute(f'DROP TABLE {table}')
            conn.execute('PRAGMA user_version=3')
        return conn

    def test_v3_upgrade_preserves_notes_and_holders_and_rolls_back_failed_ddl(self):
        conn = self.legacy_v3()
        before = [tuple(r) for r in conn.execute('SELECT * FROM stock_notes')]
        with patch.object(migrations, 'COMPANY_PROFILE_SCHEMA', migrations.COMPANY_PROFILE_SCHEMA + 'INVALID SQL;'):
            with self.assertRaises(sqlite3.OperationalError):
                initialize_connection(conn)
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 3)
        self.assertNotIn('holding_ratio', {r[1] for r in conn.execute('PRAGMA table_info(stock_shareholders)')})
        initialize_connection(conn)
        initialize_connection(conn)
        self.assertEqual(conn.execute('PRAGMA user_version').fetchone()[0], 4)
        self.assertEqual([tuple(r) for r in conn.execute('SELECT * FROM stock_notes')], before)
        self.assertEqual(conn.execute('SELECT holder_name,holding_ratio FROM stock_shareholders').fetchone()[:], ('旧股东', None))

    def test_seed_only_backfills_identical_complete_report_and_never_changes_personal_data(self):
        root = Path(__file__).resolve().parents[1] / '.build' / ('shareholder-details-' + uuid4().hex)
        root.mkdir(parents=True)
        path, resource = root / 'archive.sqlite3', root / 'seed.gz'
        with closing(initialize(path)) as conn:
            db.save_day(conn, '2026-10-30', [{'code': c, 'name': c, 'boards': 1} for c in ('000001', '000002', '000003')], 'synthetic')
            for code in ('000001', '000002', '000003'):
                save_batch(conn, [code], {'total': [self.row(code, '旧股东')]})
            conn.execute('UPDATE shareholder_profiles SET ratio_checked=0')
            conn.commit()
            db.save_stock_note(conn, '000001', '不要覆盖', 0)
        profiles = [{'code': c, 'scope': 'total', 'report_date': '2026-06-30' if c == '000003' else '2026-09-30',
                     'source': 'synthetic', 'fetched_at': now_iso(), 'ratio_checked': 1} for c in ('000001', '000002', '000003')]
        rows = [{**self.row(c, '不同股东' if c == '000002' else '旧股东', 12.3456), 'scope': 'total'} for c in ('000001', '000002', '000003')]
        resource.write_bytes(gzip.compress(json.dumps({'profiles': profiles, 'rows': rows}).encode()))
        shareholder_seed.apply(path, resource)
        shareholder_seed.apply(path, resource)
        with closing(connect(path)) as conn:
            values = {r['code']: r['holding_ratio'] for r in conn.execute('SELECT code,holding_ratio FROM stock_shareholders')}
            self.assertEqual(values, {'000001': 12.3456, '000002': None, '000003': None})
            self.assertEqual(conn.execute('SELECT content FROM stock_notes').fetchone()[0], '不要覆盖')

    def test_legacy_ratio_cache_triggers_refresh_even_with_fresh_global_time(self):
        root = Path(__file__).resolve().parents[1] / '.build' / ('ratio-policy-' + uuid4().hex)
        path = root / 'archive.sqlite3'
        with closing(initialize(path)) as conn:
            conn.execute("INSERT INTO stocks VALUES ('000001','测试','深市主板','2026-10-30')")
            conn.execute("INSERT INTO shareholder_profiles VALUES ('000001','total','2026-09-30','synthetic',?,0)", (now_iso(),))
            conn.commit()
            db.set_settings(conn, shareholder_fetched_at=now_iso(), shareholder_requested=1)
        job = MetadataRefresher(path, prefix='shareholder', refresh_callback=lambda _: None)
        self.addCleanup(job.stop)
        with patch('lianban.runtime.metadata.threading.Thread') as thread:
            job.maybe_refresh()
            thread.return_value.start.assert_called_once()


if __name__ == '__main__':
    unittest.main()
