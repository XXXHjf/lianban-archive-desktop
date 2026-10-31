"""The daily column sums current float disclosures without per-stock queries."""
from contextlib import closing
import unittest

from lianban.storage import initialize
from lianban.storage.shareholders import save_batch
from lianban.readside.stock_profiles import enrich_float_holding_ratios
from lianban.archive.queries import date_view
from lianban.archive.service import save_day


class FloatHoldingColumnTests(unittest.TestCase):
    def test_batched_sum_keeps_raw_precision_scopes_zero_and_unknown(self):
        with closing(initialize(':memory:')) as conn:
            def row(code, name, ratio):
                return {'code': code, 'holder_key': name, 'holder_name': name,
                        'holder_type': '个人', 'report_date': '2026-09-30', 'holding_ratio': ratio}
            save_batch(conn, ['000001'], {'float': [row('000001', '甲', 27.31455), row('000001', '乙', 28.31455)],
                                         'total': [row('000001', '甲', 99)]})
            save_batch(conn, ['000002'], {'float': [row('000002', '丙', 0)]})
            save_batch(conn, ['000003'], {'float': [row('000003', '丁', None)]})
            rows = [{'code': code} for code in ('000001', '000002', '000003', '000004')]
            statements = []
            conn.set_trace_callback(statements.append)
            enrich_float_holding_ratios(conn, rows)
            conn.set_trace_callback(None)
            self.assertAlmostEqual(rows[0]['float_holding_ratio'], 55.6291)
            self.assertEqual(rows[1]['float_holding_ratio'], 0)
            self.assertIsNone(rows[2]['float_holding_ratio'])
            self.assertIsNone(rows[3]['float_holding_ratio'])
            self.assertEqual(len(statements), 1)
            save_day(conn, '2026-10-30', [{'code': '000001', 'name': '合成测试', 'boards': 1}], 'synthetic')
            self.assertAlmostEqual(date_view(conn, '2026-10-30')['rows'][0]['float_holding_ratio'], 55.6291)


if __name__ == '__main__':
    unittest.main()
