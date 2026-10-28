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

    def test_add_and_edit_history_reorders_latest_summary_without_losing_other_entries(self):
        first = db.save_stock_note(self.conn, "601811", "原备注", 0, occurred_at="2026-10-20T09:30", new_entry=True)
        first_id = first["latest_entry_id"]
        second = db.save_stock_note(self.conn, "601811", "最新备注", 1, occurred_at="2026-10-23T15:00:01", new_entry=True)
        second_id = second["latest_entry_id"]
        self.assertEqual(len(second["entries"]), 2)
        edited = db.save_stock_note(self.conn, "601811", "历史内容修改", 2, entry_id=first_id, occurred_at="2026-10-21T12:00:00")
        self.assertEqual((edited["content"], edited["latest_entry_id"]), ("最新备注", second_id))
        self.assertEqual(edited["entries"][1]["content"], "历史内容修改")
        moved = db.save_stock_note(self.conn, "601811", "改时间成为最新", 3, entry_id=first_id, occurred_at="2026-10-24T08:00:00")
        self.assertEqual((moved["content"], moved["latest_entry_id"]), ("改时间成为最新", first_id))
        self.assertEqual(len(moved["entries"]), 2, "editing must not append duplicate history records")
        self.assertEqual(moved["entries"][1]["content"], "最新备注")
        self.assertEqual(db.date_view(self.conn, "2026-10-16")["rows"][0]["note"], "改时间成为最新")
        self.assertEqual(db.stock_view(self.conn, "601811", "2026-10-15", "2026-10-16")["stock"]["note"], "改时间成为最新")
        cleared = db.save_stock_note(self.conn, "601811", "", 4, entry_id=first_id)
        self.assertEqual((cleared["content"], len(cleared["entries"])), ("", 2))
        self.assertEqual(cleared["entries"][0]["occurred_at"], "2026-10-24T08:00:00+08:00")

    def test_history_timestamp_normalization_ties_validation_and_conflicts(self):
        first = db.save_stock_note(self.conn, "601811", "同一时刻甲", 0, occurred_at="2026-10-23T01:30Z", new_entry=True)
        second = db.save_stock_note(self.conn, "601811", "同一时刻乙", 1, occurred_at="2026-10-23T09:30:00+08:00", new_entry=True)
        self.assertEqual(second["entries"][0]["occurred_at"], first["entries"][0]["occurred_at"])
        self.assertEqual(second["content"], "同一时刻乙", "identical times use the newest entry id as a stable tie-breaker")
        before = db.get_stock_note(self.conn, "601811")
        for kwargs in ({"occurred_at": "2026-02-30T09:30"}, {"occurred_at": "2026-10-23"},
                       {"occurred_at": "2026-10-23T09:30+24:00"}, {"occurred_at": 123},
                       {"entry_id": True}, {"entry_id": -1}, {"entry_id": 999},
                       {"entry_id": first["latest_entry_id"], "new_entry": True}, {"new_entry": "yes"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                db.save_stock_note(self.conn, "601811", "无效编辑", 2, **kwargs)
            self.assertEqual(db.get_stock_note(self.conn, "601811"), before)
        with self.assertRaises(db.NoteConflictError):
            db.save_stock_note(self.conn, "601811", "旧窗口新增", 1, new_entry=True)
        db.save_day(self.conn, "2026-10-16", [{"code": "000001", "name": "其他股票", "boards": 1}], "synthetic")
        with self.assertRaises(ValueError):
            db.save_stock_note(self.conn, "000001", "不能编辑其他股票的节点", 0, entry_id=first["latest_entry_id"])
        self.assertEqual(db.get_stock_note(self.conn, "601811"), before)

    def test_legacy_migration_preserves_content_time_revision_and_is_idempotent(self):
        path = Path(__file__).parent / "test-data" / ("note-history-migration-" + uuid4().hex + ".sqlite3")
        with closing(db.connect(path)) as conn:
            db.save_day(conn, "2026-10-16", [{"code": "601811", "name": "样本股票", "boards": 3}], "synthetic")
            with conn:
                conn.execute("DELETE FROM settings WHERE key='stock_note_history'")
                conn.execute("INSERT INTO stock_notes VALUES ('601811','旧备注\n保留换行',7,'2026-10-19T21:30:05+08:00')")
        for _ in range(2):
            with closing(db.connect(path)) as conn:
                note = db.get_stock_note(conn, "601811")
                self.assertEqual((note["content"], note["revision"]), ("旧备注\n保留换行", 7))
                self.assertEqual(len(note["entries"]), 1)
                self.assertEqual(note["entries"][0]["occurred_at"], "2026-10-19T21:30:05+08:00")

    def test_api_history_roundtrip_and_read_only_write_guard(self):
        args = {"code": "601811", "content": "新时间节点", "revision": 0,
                "occurred_at": "2026-10-25T13:14:15", "new_entry": True}
        status, created = self.request(args)
        self.assertEqual(status, 200)
        entry_id = created["latest_entry_id"]
        status, updated = self.request({**args, "content": "修改历史节点", "revision": 1,
                                        "entry_id": entry_id, "new_entry": False, "occurred_at": "2026-10-24T09:00"})
        self.assertEqual(status, 200)
        self.assertEqual((updated["entries"][0]["content"], updated["entries"][0]["occurred_at"]),
                         ("修改历史节点", "2026-10-24T09:00:00+08:00"))
        self.assertEqual(self.request({**args, "revision": 2}, read_only=True)[0], 403)
        self.assertEqual(self.request({**args, "revision": 2, "occurred_at": "bad"})[0], 400)
        self.assertEqual(self.request(method="GET")[1], updated)

    def test_optional_dates_keep_legacy_timestamps_and_allow_clearing_date(self):
        first = db.save_stock_note(self.conn, "601811", "旧备注", 0, occurred_at="2026-10-23T15:00:01+08:00", new_entry=True)
        first_id = first["latest_entry_id"]
        self.assertEqual(first["entries"][0]["note_date"], "2026-10-23")
        edited = db.save_stock_note(self.conn, "601811", "仅修改内容", 1, entry_id=first_id, note_date="2026-10-23")
        self.assertEqual(edited["entries"][0]["occurred_at"], first["entries"][0]["occurred_at"], "displaying dates only must not erase stored legacy timestamps")
        undated = db.save_stock_note(self.conn, "601811", "无日期备注", 2, note_date="", new_entry=True)
        undated_id = undated["latest_entry_id"]
        self.assertEqual(undated["entries"][0]["note_date"], "")
        dated = db.save_stock_note(self.conn, "601811", "补上日期", 3, entry_id=undated_id, note_date="2026-10-24")
        self.assertEqual(next(e for e in dated["entries"] if e["id"] == undated_id)["note_date"], "2026-10-24")
        cleared = db.save_stock_note(self.conn, "601811", "再次不填日期", 4, entry_id=undated_id, note_date=None)
        self.assertEqual(next(e for e in cleared["entries"] if e["id"] == undated_id)["note_date"], "")
        for invalid in ("2026-02-30", "2026-1-2", "2026-10-25T09:30", "bad", False, 123):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                db.save_stock_note(self.conn, "601811", "无效日期", 5, entry_id=undated_id, note_date=invalid)
        self.assertEqual(db.get_stock_note(self.conn, "601811"), cleared)

    def test_delete_whole_note_and_restore_preserve_other_entries_and_revision(self):
        first = db.save_stock_note(self.conn, "601811", "较早备注", 0, occurred_at="2026-10-20T09:30", new_entry=True)
        old_id = first["latest_entry_id"]
        latest = db.save_stock_note(self.conn, "601811", "较新备注", 1, note_date="", new_entry=True)
        latest_id = latest["latest_entry_id"]
        removed = db.change_stock_note_entry(self.conn, "601811", latest_id, 2, "delete")
        self.assertEqual((removed["content"], len(removed["entries"]), removed["revision"]), ("较早备注", 1, 3))
        self.assertEqual(db.date_view(self.conn, "2026-10-16")["rows"][0]["note"], "较早备注")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM stock_note_entries").fetchone()[0], 2, "deletion must remain recoverable")
        with self.assertRaises(db.NoteConflictError):
            db.change_stock_note_entry(self.conn, "601811", old_id, 2, "delete")
        with self.assertRaises(ValueError):
            db.save_stock_note(self.conn, "601811", "已删除的节点不能被旧窗口修改", 3, entry_id=latest_id)
        restored = db.change_stock_note_entry(self.conn, "601811", latest_id, 3, "restore")
        self.assertEqual((restored["content"], len(restored["entries"])), ("较新备注", 2))
        self.assertEqual(restored["entries"][0]["note_date"], "")
        db.change_stock_note_entry(self.conn, "601811", old_id, 4, "delete")
        empty = db.change_stock_note_entry(self.conn, "601811", latest_id, 5, "delete")
        self.assertEqual((empty["content"], empty["entries"], empty["latest_entry_id"], empty["revision"]), ("", [], None, 6))
        recovered = db.change_stock_note_entry(self.conn, "601811", old_id, 6, "restore")
        self.assertEqual((recovered["content"], recovered["entries"][0]["note_date"]), ("较早备注", "2026-10-20"))
        for action, entry_id in (("bad", old_id), ("delete", True), ("restore", old_id), ("delete", 999)):
            with self.subTest(action=action, entry_id=entry_id), self.assertRaises(ValueError):
                db.change_stock_note_entry(self.conn, "601811", entry_id, 7, action)
        self.assertEqual(db.get_stock_note(self.conn, "601811"), recovered)

    def test_api_optional_date_delete_restore_and_read_only_guard(self):
        args = {"code":"601811", "content":"不带日期", "revision":0, "note_date":"", "new_entry":True}
        status, created = self.request(args)
        self.assertEqual(status, 200)
        self.assertEqual(created["entries"][0]["note_date"], "")
        action = {"code":"601811", "entry_id":created["latest_entry_id"], "revision":1, "action":"delete"}
        self.assertEqual(self.request(action, read_only=True)[0], 403)
        status, removed = self.request(action)
        self.assertEqual((status, removed["entries"], removed["content"]), (200, [], ""))
        self.assertEqual(self.request(action)[0], 409)
        undo = {**action,"revision":2,"action":"restore"}
        self.assertEqual(self.request(undo, read_only=True)[0], 403)
        status, restored = self.request(undo)
        self.assertEqual(status, 200)
        self.assertEqual((restored["content"],restored["entries"][0]["note_date"]), ("不带日期", ""))
        self.assertEqual(self.request({**undo,"revision":3,"action":"bad"})[0], 400)
        db.save_day(self.conn, "2026-10-16", [{"code":"000001","name":"其他股票","boards":1}], "synthetic")
        self.assertEqual(self.request({**action,"code":"000001","revision":0})[0], 400)

    def test_undated_and_deleted_entries_survive_reopening(self):
        path = Path(__file__).parent / "test-data" / ("note-options-" + uuid4().hex + ".sqlite3")
        with closing(db.connect(path)) as conn:
            db.save_day(conn, "2026-10-16", [{"code":"601811","name":"样本股票","boards":3}], "synthetic")
            saved = db.save_stock_note(conn,"601811","重启保留的无日期备注",0,note_date="",new_entry=True)
            entry_id = saved["latest_entry_id"]
            db.change_stock_note_entry(conn,"601811",entry_id,1,"delete")
        with closing(db.connect(path)) as conn:
            self.assertEqual(db.get_stock_note(conn,"601811")["entries"], [])
            restored = db.change_stock_note_entry(conn,"601811",entry_id,2,"restore")
            self.assertEqual((restored["content"],restored["entries"][0]["note_date"]), ("重启保留的无日期备注", ""))


if __name__ == "__main__":
    unittest.main()
