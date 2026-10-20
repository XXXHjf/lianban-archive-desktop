"""Blacklist membership, persistence, archive isolation, and HTTP validation."""
from contextlib import nullcontext
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import app
import database as db


class BlacklistTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        for day in ("2026-10-15", "2026-10-16"):
            db.save_day(self.conn, day, [
                {"code": "000001", "name": "测试甲", "boards": 1},
                {"code": "600001", "name": "测试乙", "boards": 2},
            ], "synthetic")

    def tearDown(self):
        self.conn.close()

    def request(self, payload=None, method="POST", read_only=False,
                content_type="application/json", raw=None, length=None):
        handler = object.__new__(app.Handler)
        handler.path = "/api/blacklist"
        handler.server = SimpleNamespace(db_path=":memory:", read_only=read_only)
        body = json.dumps(payload).encode("utf-8") if raw is None else raw
        handler.headers = {"Content-Type": content_type,
                           "Content-Length": str(len(body) if length is None else length)}
        handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
        result = {}
        handler.send_response = lambda status: result.update(status=status)
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        with patch.object(app.db, "connect", return_value=self.conn), \
                patch.object(app, "closing", side_effect=nullcontext):
            getattr(handler, "do_" + method)()
        result["body"] = json.loads(handler.wfile.getvalue())
        return result

    def test_add_duplicate_remove_and_readd(self):
        self.assertEqual(db.get_blacklist(self.conn), {"rows": [], "total": 0})
        first = db.save_blacklist(self.conn, "000001", "add")
        self.assertTrue(first["changed"])
        with patch.object(db, "now_iso", return_value="2099-01-01T00:00:00+08:00"):
            duplicate = db.save_blacklist(self.conn, "000001", "add")
        self.assertFalse(duplicate["changed"])
        self.assertEqual(duplicate["rows"], first["rows"])
        db.save_blacklist(self.conn, "600001", "add")
        removed = db.save_blacklist(self.conn, "000001", "remove")
        self.assertTrue(removed["changed"])
        self.assertEqual([row["code"] for row in removed["rows"]], ["600001"])
        self.assertFalse(db.save_blacklist(self.conn, "000001", "remove")["changed"])
        self.assertEqual(db.save_blacklist(self.conn, "000001", "add")["total"], 2)

    def test_name_updates_follow_code_without_changing_membership(self):
        added = db.save_blacklist(self.conn, "000001", "add")
        db.save_day(self.conn, "2026-10-17", [
            {"code": "000001", "name": "更名甲", "boards": 2}], "synthetic")
        row = db.get_blacklist(self.conn)["rows"][0]
        self.assertEqual(row["name"], "更名甲")
        self.assertEqual(row["created_at"], added["rows"][0]["created_at"])

    def test_blacklist_does_not_change_archive_or_tags(self):
        db.save_stock_tags(self.conn, "000001", ["自定义"], 0)
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        for action in ("add", "remove"):
            db.save_blacklist(self.conn, "000001", action)
            self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])
            self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], ["自定义"])

    def test_invalid_codes_actions_and_unknown_stocks_are_atomic(self):
        db.save_blacklist(self.conn, "000001", "add")
        before = db.get_blacklist(self.conn)
        for code in (None, True, 1, "1", "000001 OR 1=1", "６００００１", "999999"):
            with self.subTest(code=code), self.assertRaises(ValueError):
                db.save_blacklist(self.conn, code, "add")
        for action in (None, [], {}, True, "clear", "delete"):
            with self.subTest(action=action), self.assertRaises(ValueError):
                db.save_blacklist(self.conn, "000001", action)
        self.assertEqual(db.get_blacklist(self.conn), before)

    def test_list_uses_current_tags_and_registered_province(self):
        added = db.save_blacklist(self.conn, "000001", "add")
        created = added["rows"][0]["created_at"]
        db.save_industries(self.conn, [{"code": "000001", "industry": "建材", "industry_level2": "",
                          "industry_level3": "", "industry_code": "480101", "effective_from": "2021-01-01",
                          "source_updated_at": "2026-10-01"}], "synthetic", db.now_iso(), [])
        db.save_registrations(self.conn, [{"code": "000001", "province": "浙江省", "city": "金华",
                              "location": "浙江 · 金华", "address": "测试注册地址"}], "synthetic", db.now_iso(), [], 1)
        self.assertEqual(db.get_blacklist(self.conn)["rows"][0]["tags"], ["建材"])
        db.save_stock_tags(self.conn, "000001", ["水泥", "医药生物"], 0)
        row = db.get_blacklist(self.conn)["rows"][0]
        self.assertEqual(row["tags"], ["水泥", "医药生物"])
        self.assertEqual(row["registered_province"], "浙江省")
        self.assertEqual(row["created_at"], created)
        db.save_stock_tags(self.conn, "000001", [], 1)
        self.assertEqual(db.get_blacklist(self.conn)["rows"][0]["tags"], [])
        self.assertEqual(db.get_blacklist(self.conn)["total"], 1)

    def test_stock_profile_follows_current_blacklist_membership(self):
        before = db.stock_view(self.conn, "600001", "2026-10-15", "2026-10-16")
        self.assertIs(before["stock"]["blacklisted"], False)
        db.save_blacklist(self.conn, "600001", "add")
        result = db.stock_view(self.conn, "600001", "2026-10-15", "2026-10-16")
        self.assertIs(result["stock"]["blacklisted"], True)
        self.assertEqual(result["rows"], before["rows"])
        self.assertEqual(result["stats"], before["stats"])
        db.save_blacklist(self.conn, "600001", "remove")
        self.assertIs(db.stock_view(self.conn, "600001", "2026-10-15", "2026-10-16")["stock"]["blacklisted"], False)

    def test_daily_cards_follow_membership_without_changing_counts(self):
        before = db.date_view(self.conn, "2026-10-16")
        self.assertTrue(all(row["blacklisted"] is False for row in before["rows"]))
        db.save_blacklist(self.conn, "600001", "add")
        result = db.date_view(self.conn, "2026-10-16")
        flags = {row["code"]: row["blacklisted"] for row in result["rows"]}
        self.assertEqual(flags, {"000001": False, "600001": True})
        self.assertEqual(result["stats"], before["stats"])
        self.assertEqual(result["tag_board_counts"], before["tag_board_counts"])
        self.assertEqual(result["board_counts"], before["board_counts"])
        self.assertIs(db.date_view(self.conn, "2026-10-16", boards=2)["rows"][0]["blacklisted"], True)
        retained = {"code": "600001", "name": "测试乙", "boards": 3, "market": "沪市主板"}
        with patch.object(db, "suspended_leaders", return_value=[retained]):
            self.assertIs(db.date_view(self.conn, "2026-10-16")["suspended_rows"][0]["blacklisted"], True)
        db.save_blacklist(self.conn, "600001", "remove")
        self.assertTrue(all(row["blacklisted"] is False for row in db.date_view(self.conn, "2026-10-16")["rows"]))

    def test_membership_survives_database_reopen(self):
        # Keep fixture files; project rules prohibit bulk cleanup.
        target = Path(__file__).parent / "test-data" / ("blacklist-" + uuid4().hex + ".sqlite3")
        conn = db.connect(target)
        try:
            db.save_day(conn, "2026-10-16", [{"code": "000001", "name": "持久股", "boards": 1}], "synthetic")
            db.save_blacklist(conn, "000001", "add")
        finally:
            conn.close()
        conn = db.connect(target)
        try:
            self.assertEqual(db.get_blacklist(conn)["rows"][0]["code"], "000001")
            db.save_blacklist(conn, "000001", "remove")
        finally:
            conn.close()
        conn = db.connect(target)
        try:
            self.assertEqual(db.get_blacklist(conn)["total"], 0)
        finally:
            conn.close()

    def test_api_get_add_remove_and_validation(self):
        self.assertEqual(self.request(method="GET")["body"]["total"], 0)
        added = self.request({"code": "000001", "action": "add"})
        self.assertEqual(added["status"], 200)
        self.assertEqual(self.request(method="GET")["body"]["total"], 1)
        self.assertEqual(self.request({"code": "000001", "action": "remove"})["body"]["total"], 0)
        for payload in ([], None, {}, {"code": "bad", "action": "add"},
                        {"code": "000001", "action": ["add"]}):
            self.assertEqual(self.request(payload)["status"], 400)
        self.assertEqual(self.request(raw=b"{")["status"], 400)
        self.assertEqual(self.request(raw=b"\xff")["status"], 400)
        self.assertEqual(self.request(content_type="text/plain")["status"], 415)
        for length in (0, 16385):
            self.assertEqual(self.request(length=length)["status"], 413)

    def test_local_handler_enforces_read_only(self):
        for action in ("add", "remove"):
            self.assertEqual(self.request({"code": "000001", "action": action}, read_only=True)["status"], 403)
        self.assertEqual(db.get_blacklist(self.conn)["total"], 0)


if __name__ == "__main__":
    unittest.main()
