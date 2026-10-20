"""Suspended heights are dated metadata, never fabricated limit-up events."""
from pathlib import Path
from contextlib import nullcontext
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
import suspension


def payload(**changes):
    row = {"SECURITY_CODE": "600001", "SECURITY_NAME_ABBR": "暂停测试", "SECUCODE": "600001.SH",
           "SUSPEND_START_TIME": "2026-10-13 09:30:00", "SUSPEND_END_TIME": "2026-10-15 15:00:00",
           "SUSPEND_START_DATE": "2026-10-13 00:00:00", "PREDICT_RESUME_DATE": "2026-10-16 00:00:00",
           "SUSPEND_REASON": "交易异常波动"}
    row.update(changes)
    return {"success": True, "code": 0, "result": {"count": 1, "pages": 1, "data": [row]}}


class SuspensionTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.set_settings(self.conn, range_start="2026-10-12", range_end="2026-10-16",
                        calendar_dates=["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"])
        db.save_day(self.conn, "2026-10-12", [{"code": "600001", "name": "暂停测试", "boards": 10}], "synthetic")
        for day in ("2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"):
            db.save_day(self.conn, day, [{"code": "000002", "name": "交易测试", "boards": 5}], "synthetic")

    def tearDown(self):
        self.conn.close()

    def save(self, day="2026-10-15", source=None):
        records, _, _ = suspension.normalize(source or payload(), day)
        db.save_suspensions(self.conn, day, records, "synthetic-suspensions", ["synthetic.json"])

    def test_confirmed_suspension_counts_height_but_not_daily_limit_ups(self):
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        db.save_stock_tags(self.conn, "600001", ["传媒", "自定义"], 0)
        self.save()
        result = db.date_view(self.conn, "2026-10-15")
        self.assertEqual(result["stats"], {"total": 1, "consecutive": 1, "max_boards": 10, "first_boards": 0})
        self.assertEqual(result["trading_max_boards"], 5)
        self.assertEqual([row["code"] for row in result["rows"]], ["000002"])
        self.assertEqual(result["suspended_rows"][0]["board_date"], "2026-10-12")
        self.assertEqual(result["suspended_rows"][0]["tags"], ["传媒", "自定义"])
        self.assertEqual(result["suspended_rows"][0]["initials"], "ZTCS")
        self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_no_status_or_resumed_day_cannot_inherit_an_old_peak(self):
        self.assertEqual(db.date_view(self.conn, "2026-10-15")["stats"]["max_boards"], 5)
        self.save()
        self.assertEqual(db.date_view(self.conn, "2026-10-16")["suspended_rows"], [])
        records, _, _ = suspension.normalize(payload(), "2026-10-16")
        self.assertFalse(records[0]["full_day"])

    def test_intervening_traded_day_and_missing_preceding_day_block_carry(self):
        db.save_day(self.conn, "2026-10-13", [{"code": "600001", "name": "暂停测试", "boards": 1}], "synthetic")
        self.save()
        self.assertEqual(db.date_view(self.conn, "2026-10-15")["suspended_rows"], [])
        later = payload(SUSPEND_START_TIME="2026-10-14 09:30:00", SUSPEND_START_DATE="2026-10-14 00:00:00")
        self.save(source=later)
        self.assertEqual(db.date_view(self.conn, "2026-10-15")["suspended_rows"], [])

    def test_intraday_pause_does_not_preserve_height(self):
        self.save(day="2026-10-13", source=payload(SUSPEND_START_TIME="2026-10-13 09:32:00",
            SUSPEND_END_TIME="2026-10-13 09:42:00", PREDICT_RESUME_DATE=None))
        self.assertEqual(db.date_view(self.conn, "2026-10-13")["suspended_rows"], [])

    def test_selected_height_and_market_filter_apply_to_retained_stock(self):
        self.save()
        self.assertEqual(db.date_view(self.conn, "2026-10-15", boards=5)["suspended_rows"], [])
        self.assertEqual(db.date_view(self.conn, "2026-10-15", market="sz")["stats"]["max_boards"], 5)
        selected = db.date_view(self.conn, "2026-10-15", boards=10)
        self.assertEqual(selected["stats"]["total"], 0)
        self.assertEqual(selected["stats"]["max_boards"], 10)

    def test_gem_exclusion_removes_trading_and_suspended_gem_heights(self):
        db.save_day(self.conn, "2026-10-12", [{"code": "300001", "name": "创业停牌", "boards": 12}], "synthetic")
        db.save_day(self.conn, "2026-10-15", [{"code": "000002", "name": "主板交易", "boards": 5},
                                               {"code": "301001", "name": "创业交易", "boards": 8}], "synthetic")
        self.save(source=payload(SECURITY_CODE="300001", SECURITY_NAME_ABBR="创业停牌", SECUCODE="300001.SZ"))
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        self.assertEqual(db.date_view(self.conn, "2026-10-15")["stats"]["max_boards"], 12)
        filtered = db.date_view(self.conn, "2026-10-15", exclude_gem=True)
        self.assertEqual([row["code"] for row in filtered["rows"]], ["000002"])
        self.assertEqual(filtered["suspended_rows"], [])
        self.assertEqual(filtered["stats"], {"total": 1, "consecutive": 1, "max_boards": 5, "first_boards": 0})
        self.assertEqual(filtered["trading_max_boards"], 5)
        self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_market_mismatch_inconsistent_dates_and_truncated_data_are_rejected(self):
        for bad in [payload(SECUCODE="600001.SZ"), payload(SUSPEND_START_DATE="2026-10-14 00:00:00"),
                    payload(SUSPEND_END_TIME="2026-10-12 15:00:00")]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                suspension.normalize(bad, "2026-10-15")
        bad = payload()
        bad["result"]["count"] = 2
        with self.assertRaises(ValueError):
            suspension.normalize(bad, "2026-10-15")

    def test_unrelated_future_intraday_row_does_not_create_retained_height(self):
        records, _, _ = suspension.normalize(payload(SUSPEND_START_TIME="2026-10-16 09:32:00",
            SUSPEND_START_DATE="2026-10-16 00:00:00", SUSPEND_END_TIME="2026-10-16 09:42:00",
            PREDICT_RESUME_DATE=None), "2026-10-15")
        self.assertFalse(records[0]["full_day"])

    def test_new_valid_empty_snapshot_removes_retention_without_touching_archive(self):
        self.save()
        db.save_suspensions(self.conn, "2026-10-15", [], "synthetic", [])
        self.assertEqual(db.date_view(self.conn, "2026-10-15")["stats"]["max_boards"], 5)
        self.assertEqual(self.conn.execute("SELECT boards FROM events WHERE code='600001'").fetchone()[0], 10)

    def test_refresh_failure_keeps_confirmed_snapshot_and_reports_error(self):
        self.save()
        worker = suspension.Refresher(":memory:")
        worker._running.add("2026-10-15")
        with patch.object(suspension, "refresh", side_effect=ValueError("synthetic network failure")), \
             patch.object(suspension.db, "connect", return_value=self.conn), \
             patch.object(suspension, "closing", side_effect=nullcontext):
            worker._run("2026-10-15")
        result = db.date_view(self.conn, "2026-10-15")
        self.assertEqual(result["suspension_status"], "error")
        self.assertEqual(result["stats"]["max_boards"], 10)
        self.assertFalse(worker._running)


if __name__ == "__main__":
    unittest.main()
