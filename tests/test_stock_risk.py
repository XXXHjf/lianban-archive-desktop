"""Distinguish stock-name risk markers from ordinary names and initials."""
import unittest

from lianban.archive.relationships import competition_group
from lianban.core.stock import is_st_name
from lianban.research.presentation import stock_initials
from lianban.research import tag_management
import database as db


class StockRiskTests(unittest.TestCase):
    def test_risk_warning_prefixes_are_normalized(self):
        for name in ('ST测试', '*ST航图', ' S * ST 测试 ', 'SST测试', '＊ｓｔ测试'):
            with self.subTest(name=name):
                self.assertTrue(is_st_name(name))

    def test_ordinary_initials_and_embedded_letters_do_not_mark_st(self):
        self.assertEqual(stock_initials('时代科技'), 'SDKJ')
        self.assertEqual(stock_initials('盛通股份'), 'STGF')
        for name in ('盛通股份', '时代科技', '测试ST科技'):
            with self.subTest(name=name):
                self.assertFalse(is_st_name(name))
                self.assertEqual(competition_group({'name': name, 'market': '沪市主板'}), ('主板', False))

    def test_history_statistics_search_and_personal_tags_preserve_data(self):
        conn = db.initialize(':memory:')
        self.addCleanup(conn.close)
        db.set_settings(conn, range_start='2026-01-02', range_end='2026-01-05',
                        calendar_dates=['2026-01-02', '2026-01-05'])
        db.save_day(conn, '2026-01-02', [
            {'code': '000001', 'name': '盛通股份', 'boards': 1},
            {'code': '000002', 'name': '*ST测试', 'boards': 2},
        ], 'test')
        db.save_stock_tags(conn, '000001', ['共同标签'], 0)
        db.save_stock_tags(conn, '000002', ['共同标签'], 0)
        db.save_day(conn, '2026-01-05', [
            {'code': '000001', 'name': '*ST盛通', 'boards': 2},
            {'code': '000002', 'name': '摘帽测试', 'boards': 3},
            {'code': '000003', 'name': '盛通股份', 'boards': 1},
        ], 'test')
        before = [tuple(row) for row in conn.execute('SELECT * FROM events ORDER BY date,code')]
        self.assertEqual([row['code'] for row in db.date_view(conn, '2026-01-02')['rows']], ['000001'])
        self.assertEqual([row['code'] for row in db.date_view(conn, '2026-01-05', exclude_st=False)['rows']], ['000002', '000003'])
        self.assertEqual(db.search_stocks(conn, 'STGF')['rows'][0]['code'], '000003')
        self.assertEqual(db.search_stocks(conn, '*ST')['rows'], [])
        meta = db.meta(conn)
        self.assertEqual((meta['coverage']['records'], meta['coverage']['stocks']), (3, 3))
        self.assertEqual({row['name'] for row in meta['examples']}, {'盛通股份', '摘帽测试'})
        view = db.stock_view(conn, '000001', '2026-01-02', '2026-01-05')
        self.assertEqual(view['stock']['name'], '盛通股份')
        self.assertEqual([row['date'] for row in view['rows']], ['2026-01-02'])
        self.assertFalse(view['cycles'][0]['end_known'])
        self.assertEqual(tag_management.members(conn, '共同标签')['count'], 1)
        self.assertEqual(tag_management.catalog(conn)['stocks'], 1)
        self.assertEqual(db.get_stock_tags(conn, '000001')['tags'], ['共同标签'])
        self.assertEqual(before, [tuple(row) for row in conn.execute('SELECT * FROM events ORDER BY date,code')])


if __name__ == '__main__':
    unittest.main()
