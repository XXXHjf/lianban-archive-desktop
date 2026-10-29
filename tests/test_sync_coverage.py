"""A short retry must never mark an incompletely backfilled archive complete."""
import sys
import unittest
from pathlib import Path
from datetime import date
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
from provider import CALENDAR_SOURCE
from sync_data import archive_coverage, archive_calendar


class SyncCoverageTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.initialize(":memory:")
        db.set_settings(self.conn, range_start="2023-01-01", range_end="2023-01-05",
                        calendar_dates=["2022-12-30", "2023-01-03", "2023-01-04", "2023-01-05"])

    def tearDown(self):
        self.conn.close()

    def save(self, day):
        db.save_day(self.conn, day, [{"code": "600001", "name": "测试股票", "boards": 1}], "synthetic-test")

    def test_bounded_retry_reports_unfetched_dates_in_the_whole_archive(self):
        self.save("2023-01-03")
        self.save("2023-01-05")
        summary, counts = archive_coverage(self.conn, ["2023-01-05"], CALENDAR_SOURCE)
        self.assertEqual(summary["coverage_status"], "partial")
        self.assertEqual(summary["missing_dates"], ["2023-01-04"])
        self.assertEqual(summary["latest_date"], "2023-01-05")
        self.assertEqual(counts, {"ok": 2, "missing": 1})
        self.save("2023-01-04")
        repaired, counts = archive_coverage(self.conn, ["2023-01-04"], CALENDAR_SOURCE)
        self.assertEqual(repaired["coverage_status"], "complete")
        self.assertEqual(repaired["missing_dates"], [])
        self.assertEqual(counts, {"ok": 3})

    def test_missing_warmup_date_does_not_mark_requested_archive_incomplete(self):
        for day in ("2023-01-03", "2023-01-04", "2023-01-05"):
            self.save(day)
        summary, _ = archive_coverage(self.conn, ["2022-12-30", "2023-01-03"], CALENDAR_SOURCE)
        self.assertEqual(summary["coverage_status"], "complete")
        self.assertNotIn("2022-12-30", summary["missing_dates"])

    def test_workday_fallback_cannot_certify_complete_coverage(self):
        for day in ("2023-01-03", "2023-01-04", "2023-01-05"):
            self.save(day)
        summary, _ = archive_coverage(self.conn, ["2023-01-02", "2023-01-03"], "unverified-weekdays")
        self.assertEqual(summary["coverage_status"], "partial")
        self.assertEqual(summary["missing_dates"], ["2023-01-02"])

    def test_multi_year_calendar_is_bounded_and_merged(self):
        spans = []
        def fetch(start, end):
            spans.append((start, end))
            return [start, end], f"calendar-{len(spans)}.json"
        with patch("lianban.ingestion.backfill.trading_dates", side_effect=fetch), patch("lianban.ingestion.backfill.time.sleep"):
            days, paths = archive_calendar("2019-12-01", "2026-10-15")
        self.assertEqual(spans[0][0], "2019-12-01")
        self.assertEqual(spans[-1][1], "2026-10-15")
        self.assertTrue(all((date.fromisoformat(end) - date.fromisoformat(start)).days < 397 for start, end in spans))
        self.assertTrue(all((date.fromisoformat(spans[i+1][0]) - date.fromisoformat(spans[i][1])).days == 1 for i in range(len(spans)-1)))
        self.assertEqual(days, sorted({day for span in spans for day in span}))
        self.assertEqual(len(paths), len(spans))

    def test_short_tail_does_not_become_a_holiday_only_request(self):
        with patch("lianban.ingestion.backfill.trading_dates", return_value=(["2020-12-31"], "calendar.json")) as fetch:
            days, paths = archive_calendar("2020-01-01", "2021-01-02")
        fetch.assert_called_once_with("2020-01-01", "2021-01-02")
        self.assertEqual((days, paths), (["2020-12-31"], ["calendar.json"]))


if __name__ == "__main__":
    unittest.main()
