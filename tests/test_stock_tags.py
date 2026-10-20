"""Persistent per-stock labels and the local editing API."""
from contextlib import nullcontext
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import database as db


class StockTagTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        for day, boards in (("2025-10-14", 1), ("2025-10-15", 2)):
            db.save_day(self.conn, day, [{"code": "000001", "name": "测试股", "boards": boards}], "synthetic")
        self.source("银行")

    def tearDown(self):
        self.conn.close()

    def source(self, name):
        db.save_industries(self.conn, [{"code": "000001", "industry": name, "industry_level2": "",
                          "industry_level3": "", "industry_code": "480101", "effective_from": "2021-01-01",
                          "source_updated_at": "2026-10-01"}], "synthetic", db.now_iso(), [])

    def test_default_and_multiple_tags_follow_stock_across_dates(self):
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], ["银行"])
        result = db.save_stock_tags(self.conn, "000001", ["银行", "金融科技"], 0)
        self.assertEqual(result["revision"], 1)
        for day in ("2025-10-14", "2025-10-15"):
            payload = db.date_view(self.conn, day)
            self.assertEqual(payload["rows"][0]["tags"], ["银行", "金融科技"])
            self.assertEqual(payload["stats"]["total"], 1)
        self.assertIsNone(self.conn.execute("SELECT industry FROM events LIMIT 1").fetchone()[0])

    def test_edit_remove_all_and_restore_source(self):
        db.save_stock_tags(self.conn, "000001", ["自定义"], 0)
        self.assertEqual(db.save_stock_tags(self.conn, "000001", ["改名标签"], 1)["tags"], ["改名标签"])
        empty = db.save_stock_tags(self.conn, "000001", [], 2)
        self.assertEqual(empty["tags"], [])
        self.assertTrue(empty["customized"])
        self.assertEqual(db.date_view(self.conn, "2025-10-14")["rows"][0]["tags"], [])
        restored = db.save_stock_tags(self.conn, "000001", [], 3, use_source=True)
        self.assertFalse(restored["customized"])
        self.assertEqual(restored["tags"], ["银行"])

    def test_stock_profile_includes_all_current_tags_and_registered_province(self):
        db.save_registrations(self.conn, [{"code": "000001", "province": "浙江省", "city": "杭州",
            "location": "浙江 · 杭州", "address": "测试注册地址"}], "synthetic", db.now_iso(), [], 1)
        db.save_stock_tags(self.conn, "000001", ["染料", "纺织", "化工"], 0)
        profile = db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-15")["stock"]
        self.assertEqual(profile["registered_province"], "浙江省")
        self.assertEqual(profile["tags"], ["染料", "纺织", "化工"])
        self.assertTrue(profile["tags_customized"])
        self.assertEqual(profile["market"], "深市主板")
        self.assertEqual(profile["initials"], "CSG")
        self.assertTrue({"registered_location", "registered_city", "registered_address"}.isdisjoint(profile))
        db.save_stock_tags(self.conn, "000001", [], 1)
        self.assertEqual(db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-15")["stock"]["tags"], [])

    def test_source_refresh_preserves_custom_tags_and_restore_tracks_new_source(self):
        db.save_stock_tags(self.conn, "000001", ["我的标签"], 0)
        self.source("传媒")
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], ["我的标签"])
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["source_tag"], "传媒")
        db.save_stock_tags(self.conn, "000001", [], 1, use_source=True)
        self.source("计算机")
        self.assertEqual(db.date_view(self.conn, "2025-10-14")["rows"][0]["tags"], ["计算机"])

    def test_tag_normalization_keeps_order_and_deduplicates(self):
        result = db.save_stock_tags(self.conn, "000001", [" AI ", "ai", "机器人", "机器人"], 0)
        self.assertEqual(result["tags"], ["AI", "机器人"])

    def test_tag_board_context_keeps_other_heights_when_selecting_one_board(self):
        day = "2025-10-15"
        db.save_day(self.conn, day, [
            {"code": "000001", "name": "五板甲", "boards": 5},
            {"code": "600002", "name": "二板乙", "boards": 2},
            {"code": "600003", "name": "首板丙", "boards": 1},
            {"code": "600004", "name": "五板丁", "boards": 5},
        ], "synthetic")
        for code, tags in [("000001", ["主业", "跨板", "同板", "独有"]),
                           ("600002", ["跨板"]), ("600003", ["首板业务"]),
                           ("600004", ["同板"])]:
            db.save_stock_tags(self.conn, code, tags, 0)
        complete = db.date_view(self.conn, day)
        selected = db.date_view(self.conn, day, boards=5)
        self.assertEqual(selected["tag_board_counts"], complete["tag_board_counts"])
        self.assertEqual(selected["tag_board_counts"]["跨板"], {"5": 1, "2": 1})
        self.assertEqual(selected["tag_board_counts"]["同板"], {"5": 2})
        self.assertEqual(selected["tag_board_counts"]["独有"], {"5": 1})
        self.assertEqual(len(selected["rows"]), 2)
        self.assertEqual(selected["stats"]["total"], 2)
        self.assertNotIn("银行", selected["tag_board_counts"])

    def test_invalid_edit_is_atomic_and_unknown_stock_is_rejected(self):
        for value in (None, "银行", [""], [1], ["x" * 31], ["bad\nname"], [str(i) for i in range(21)]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                db.save_stock_tags(self.conn, "000001", value, 0)
            self.assertEqual(db.get_stock_tags(self.conn, "000001")["revision"], 0)
        for revision in (True, -1, "0", None):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                db.save_stock_tags(self.conn, "000001", ["有效"], revision)
        with self.assertRaises(ValueError):
            db.save_stock_tags(self.conn, "600000", ["未知"], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM stock_tag_overrides").fetchone()[0], 0)

    def test_stale_editor_cannot_overwrite_newer_tags(self):
        db.save_stock_tags(self.conn, "000001", ["已保存"], 0)
        with self.assertRaises(db.TagConflictError):
            db.save_stock_tags(self.conn, "000001", ["过期内容"], 0)
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], ["已保存"])

    def request(self, path, method="GET", payload=None, content_type="application/json"):
        handler = object.__new__(app.Handler)
        handler.path = path
        handler.server = SimpleNamespace(db_path=":memory:")
        body = json.dumps(payload).encode("utf-8")
        handler.headers = {"Content-Type": content_type, "Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        result = {}
        handler.send_response = lambda status: result.update(status=status)
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        with patch.object(app.db, "connect", return_value=self.conn), patch.object(app, "closing", side_effect=nullcontext):
            getattr(handler, "do_" + method)()
        result["body"] = json.loads(handler.wfile.getvalue())
        return result

    def test_api_edit_get_conflict_and_bad_json_shape(self):
        args = {"code": "000001", "tags": ["银行", "金融科技"], "revision": 0}
        self.assertEqual(self.request("/api/stock-tags", "POST", args)["status"], 200)
        self.assertEqual(self.request("/api/stock-tags?code=000001")["body"]["tags"], ["银行", "金融科技"])
        self.assertEqual(self.request("/api/stock-tags", "POST", args)["status"], 409)
        self.assertEqual(self.request("/api/stock-tags", "POST", ["bad"])["status"], 400)
        self.assertEqual(self.request("/api/stock-tags", "POST", args, "text/plain")["status"], 415)
        self.assertEqual(self.request("/api/stock-tags?code=not-a-code")["status"], 400)

    def test_editor_loads_blacklist_membership_without_coupling_tag_saves(self):
        self.assertFalse(self.request("/api/stock-tags?code=000001")["body"]["blacklisted"])
        self.request("/api/blacklist", "POST", {"code": "000001", "action": "add"})
        self.assertTrue(self.request("/api/stock-tags?code=000001")["body"]["blacklisted"])
        saved = self.request("/api/stock-tags", "POST", {"code": "000001", "tags": ["新标签"], "revision": 0})
        self.assertTrue(saved["body"]["blacklisted"])
        self.request("/api/blacklist", "POST", {"code": "000001", "action": "remove"})
        loaded = self.request("/api/stock-tags?code=000001")["body"]
        self.assertFalse(loaded["blacklisted"])
        self.assertEqual(loaded["tags"], ["新标签"])
        self.assertEqual(loaded["revision"], 1)


if __name__ == "__main__":
    unittest.main()
