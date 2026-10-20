"""Stock notes persist independently from archive facts and tag edits."""
from contextlib import closing, nullcontext
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import app
import database as db


class StockNoteTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        for day in ("2026-10-15", "2026-10-16"):
            db.save_day(self.conn, day, [{"code": "601811", "name": "样本股票", "boards": 3}], "synthetic")

    def tearDown(self):
        self.conn.close()

    def request(self, payload=None, method="POST", read_only=False, content_type="application/json"):
        handler = object.__new__(app.Handler)
        handler.path = "/api/stock-note?code=601811" if method == "GET" else "/api/stock-note"
        handler.server = SimpleNamespace(db_path=":memory:", read_only=read_only)
        body = json.dumps(payload).encode("utf-8")
        handler.headers = {"Content-Type": content_type, "Content-Length": str(len(body))}
        handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
        result = {}
        handler.send_response = lambda status: result.update(status=status)
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        with patch.object(app.db, "connect", return_value=self.conn), patch.object(app, "closing", side_effect=nullcontext):
            getattr(handler, "do_" + method)()
        return result["status"], json.loads(handler.wfile.getvalue())

    def test_note_follows_stock_across_days_and_survives_archive_and_tag_updates(self):
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date")]
        content = "自定义第一行\n  第二行 <script>literal text</script>"
        saved = db.save_stock_note(self.conn, "601811", content, 0)
        self.assertEqual(saved["revision"], 1)
        db.save_stock_tags(self.conn, "601811", ["标签甲", "标签乙"], 0)
        for day in ("2026-10-15", "2026-10-16"):
            db.save_day(self.conn, day, [{"code": "601811", "name": "样本股票", "boards": 3}], "synthetic")
            row = db.date_view(self.conn, day)["rows"][0]
            self.assertEqual((row["note"], row["tags"]), (content, ["标签甲", "标签乙"]))
        self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date")])

    def test_reopen_database_retains_note_and_clear_keeps_revision(self):
        path = Path(__file__).parent / "test-data" / ("stock-note-" + uuid4().hex + ".sqlite3")
        with closing(db.connect(path)) as conn:
            db.save_day(conn, "2026-10-16", [{"code": "601811", "name": "样本股票", "boards": 3}], "synthetic")
            db.save_stock_note(conn, "601811", "跨重启保留", 0)
        with closing(db.connect(path)) as conn:
            self.assertEqual(db.get_stock_note(conn, "601811")["content"], "跨重启保留")
            cleared = db.save_stock_note(conn, "601811", " \n\t", 1)
            self.assertEqual((cleared["content"], cleared["revision"]), ("", 2))
            with self.assertRaises(db.NoteConflictError):
                db.save_stock_note(conn, "601811", "过期窗口不能覆盖清除结果", 1)
            self.assertEqual(db.get_stock_note(conn, "601811")["content"], "")

    def test_invalid_input_and_stale_revision_do_not_change_saved_note(self):
        db.save_stock_note(self.conn, "601811", "已保存", 0)
        for content, revision in ((None, 1), ([], 1), ("x" * 5001, 1), ("bad\0text", 1), ("text", True), ("text", -1)):
            with self.subTest(content=str(content)[:20], revision=revision), self.assertRaises(ValueError):
                db.save_stock_note(self.conn, "601811", content, revision)
        with self.assertRaises(db.NoteConflictError):
            db.save_stock_note(self.conn, "601811", "过期内容", 0)
        for code in ("../x", "000001", "６０１８１１"):
            with self.subTest(code=code), self.assertRaises(ValueError):
                db.save_stock_note(self.conn, code, "text", 0)
        self.assertEqual(db.get_stock_note(self.conn, "601811")["content"], "已保存")

    def test_api_plain_text_limit_conflict_and_read_only_permissions(self):
        self.assertEqual(self.request(method="GET")[1]["content"], "")
        args = {"code": "601811", "content": "中文" * 2500, "revision": 0}
        self.assertEqual(self.request(args)[0], 200)
        self.assertEqual(self.request(method="GET")[1]["content"], args["content"])
        self.assertEqual(self.request(args)[0], 409)
        self.assertEqual(self.request({**args, "revision": 1}, read_only=True)[0], 403)
        self.assertEqual(self.request(args, content_type="text/plain")[0], 415)
        self.assertEqual(self.request(["bad"])[0], 400)
        self.assertEqual(self.request(method="GET", read_only=True)[0], 200)


if __name__ == "__main__":
    unittest.main()
