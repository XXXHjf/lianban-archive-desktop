"""Latest-day presentation metadata must not change historical facts."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db


class LatestHighlightTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.set_settings(self.conn, range_start="2026-07-23", range_end="2026-07-30")

    def tearDown(self):
        self.conn.close()

    def save(self, day, code="600001", boards=1, **kwargs):
        db.save_day(self.conn, day, [{"code": code, "name": "历史名称", "boards": boards}], "synthetic", **kwargs)

    def test_latest_confirmed_day_ignores_failed_dates_and_outside_archive(self):
        self.save("2026-07-22", "000001")
        self.save("2026-07-23")
        self.save("2026-07-29", "600002", 3)
        db.save_day(self.conn, "2026-07-30", [], "synthetic", status="failed")
        self.save("2026-07-31", "600003", 4)
        meta = db.meta(self.conn)
        self.assertEqual(meta["latest_date"], "2026-07-29")
        self.assertEqual(meta["latest_limit_ups"], [{"code": "600002", "boards": 3}])

    def test_historical_query_keeps_name_and_board_height(self):
        self.save("2026-07-23", boards=2)
        self.save("2026-07-24", boards=3)
        before = db.date_view(self.conn, "2026-07-23")
        meta = db.meta(self.conn)
        after = db.date_view(self.conn, "2026-07-23")
        self.assertEqual(before, after)
        self.assertEqual(after["rows"][0]["boards"], 2)
        self.assertEqual(meta["latest_limit_ups"], [{"code": "600001", "boards": 3}])

    def test_same_count_source_correction_replaces_latest_membership(self):
        self.save("2026-07-29", "000001")
        self.save("2026-07-29", "000002")
        self.assertEqual(db.meta(self.conn)["latest_limit_ups"], [{"code": "000002", "boards": 1}])

    def test_empty_archive_has_no_latest_highlights(self):
        self.assertEqual(db.meta(self.conn)["latest_limit_ups"], [])


if __name__ == "__main__":
    unittest.main()
