"""Automatic closing-pool updates; synthetic fixtures, no network or file cleanup."""
from contextlib import nullcontext
from datetime import datetime
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
import live_update
from lianban.ingestion import archive_update
from lianban.runtime import metadata
from lianban.adapters.providers import pools as provider
from lianban.profiles import registration


class LiveUpdateTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.initialize(":memory:")
        db.set_settings(self.conn, range_start="2026-10-13", range_end="2026-10-13",
                        calendar_dates=["2026-10-13"])
        self.row = {"date": "2026-10-13", "code": "000001", "name": "测试股份", "boards": 1,
                    "market": "深市主板", "industry": None, "close": 10.0, "pct_change": 10.0,
                    "turnover": None, "first_time": "09:30:00", "last_time": "14:00:00",
                    "open_times": 0, "limit_up_reason": "", "source": provider.SOURCE}
        with patch("lianban.archive.service.now_iso", return_value="2026-10-13T16:00:00+08:00"):
            db.save_day(self.conn, "2026-10-13", [self.row], provider.SOURCE)
        self.stop = Mock()
        self.stop.is_set.return_value = False
        self.stop.wait.return_value = False

    def tearDown(self):
        self.conn.close()

    def result(self, day, *, empty=False, boards=1):
        return provider.DayResult(day, [] if empty else [{**self.row, "date": day, "boards": boards}],
                                  "empty" if empty else "ok", "synthetic", "synthetic.json")

    def run_refresh(self, calendar, responses, now="2026-10-15T16:00:00+08:00"):
        with patch.object(archive_update, "connect", return_value=self.conn), \
             patch.object(archive_update, "closing", side_effect=nullcontext), \
             patch.object(provider, "trading_dates", return_value=(calendar, "calendar.json")) as dates, \
             patch.object(provider, "fetch_day", side_effect=lambda day, **kwargs: responses[day]) as fetch:
            live_update.refresh(":memory:", now=datetime.fromisoformat(now), stop=self.stop)
        return dates, fetch

    def test_today_is_eligible_only_after_close_in_shanghai(self):
        for moment in ["2026-10-15T15:10:00+08:00", "2026-10-15T15:29:59+08:00"]:
            self.assertEqual(live_update.target_day(datetime.fromisoformat(moment)), "2026-10-14")
        self.assertEqual(live_update.target_day(datetime.fromisoformat("2026-10-15T07:30:00+00:00")), "2026-10-15")

    def test_checks_align_to_1530_after_restart_and_handle_midnight(self):
        cases = [("2026-10-15T15:26:42+08:00", "2026-10-15T15:30:00+08:00"),
                 ("2026-10-15T07:29:59+00:00", "2026-10-15T15:30:00+08:00"),
                 ("2026-10-15T15:30:00+08:00", "2026-10-15T15:35:00+08:00"),
                 ("2026-10-15T23:58:00+08:00", "2026-10-16T00:00:00+08:00")]
        for moment, expected in cases:
            self.assertEqual(live_update.next_check_at(datetime.fromisoformat(moment)).isoformat(), expected)

    def test_1530_rechecks_today_if_a_snapshot_was_saved_before_cutoff(self):
        day = "2026-10-15"
        with patch("lianban.archive.service.now_iso", return_value="2026-10-15T15:15:00+08:00"):
            db.save_day(self.conn, day, self.result(day).records, provider.SOURCE)
        db.set_settings(self.conn, calendar_dates=["2026-10-13", day],
                        auto_update_day_checks={"2026-10-13": "2026-10-15T15:29:00+08:00",
                                                day: "2026-10-15T15:15:00+08:00"})
        _, fetch = self.run_refresh(["2026-10-13", day],
                                   {day: self.result(day, boards=2)}, now="2026-10-15T15:30:00+08:00")
        self.assertEqual(fetch.call_args_list[0].args[0], day)
        self.assertEqual(db.date_view(self.conn, day)["rows"][0]["boards"], 2)
        self.assertEqual(db.meta(self.conn)["auto_update_time"], "15:30")

    def test_latest_session_is_fetched_before_old_gaps(self):
        _, fetch = self.run_refresh(["2026-10-13", "2026-10-14", "2026-10-15"],
                                   {day: self.result(day) for day in ["2026-10-14", "2026-10-15"]},
                                   now="2026-10-15T15:30:00+08:00")
        self.assertEqual([call.args[0] for call in fetch.call_args_list], ["2026-10-15", "2026-10-14"])

    def test_new_dates_expand_archive_and_old_gaps_are_retried(self):
        self.run_refresh(["2026-10-13", "2026-10-14", "2026-10-15"],
                         {day: self.result(day) for day in ["2026-10-14", "2026-10-15"]})
        meta = db.meta(self.conn)
        self.assertEqual(meta["latest_date"], "2026-10-15")
        self.assertEqual(meta["coverage"]["days"], 3)
        self.assertEqual(meta["auto_update_status"], "current")
        self.assertEqual(meta["calendar_dates"], ["2026-10-13", "2026-10-14", "2026-10-15"])

    def test_unpublished_today_is_waiting_not_an_empty_confirmed_day(self):
        self.run_refresh(["2026-10-13", "2026-10-14", "2026-10-15"],
                         {"2026-10-14": self.result("2026-10-14"), "2026-10-15": self.result("2026-10-15", empty=True)})
        meta = db.meta(self.conn)
        self.assertEqual(meta["latest_date"], "2026-10-14")
        self.assertEqual(meta["auto_update_status"], "waiting")
        self.assertEqual(meta["missing_dates"], ["2026-10-15"])
        self.assertEqual(db.date_view(self.conn, "2026-10-15")["data_status"], "empty")
        self.assertEqual(meta["coverage"]["status"], "partial")

    def test_before_close_does_not_fetch_today_even_when_calendar_contains_it(self):
        _, fetch = self.run_refresh(["2026-10-13", "2026-10-14"],
                                   {day: self.result(day) for day in ["2026-10-13", "2026-10-14"]},
                                   now="2026-10-15T15:29:59+08:00")
        self.assertNotIn("2026-10-15", [call.args[0] for call in fetch.call_args_list])
        self.assertEqual(db.meta(self.conn)["latest_date"], "2026-10-14")

    def test_weekend_does_not_create_fake_missing_weekdays(self):
        self.run_refresh(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"],
                         {day: self.result(day) for day in ["2026-10-14", "2026-10-15", "2026-10-16"]},
                         now="2026-10-18T16:00:00+08:00")
        meta = db.meta(self.conn)
        self.assertEqual(meta["latest_date"], "2026-10-16")
        self.assertEqual(meta["missing_dates"], [])

    def test_unchanged_snapshot_does_not_rewrite_facts_or_check_again_in_five_minutes(self):
        before = db.meta(self.conn)["archive_updated_at"]
        self.run_refresh(["2026-10-13"], {"2026-10-13": self.result("2026-10-13")})
        self.assertEqual(db.meta(self.conn)["archive_updated_at"], before)
        _, fetch = self.run_refresh(["2026-10-13"], {}, now="2026-10-15T16:05:00+08:00")
        fetch.assert_not_called()

    def test_source_correction_changes_snapshot_without_changing_custom_tags(self):
        db.save_stock_tags(self.conn, "000001", ["自定义标签"], 0)
        self.run_refresh(["2026-10-13"], {"2026-10-13": self.result("2026-10-13", boards=2)})
        row = db.date_view(self.conn, "2026-10-13")["rows"][0]
        self.assertEqual(row["boards"], 2)
        self.assertEqual(row["tags"], ["自定义标签"])

    def test_network_failure_retries_and_preserves_confirmed_snapshot(self):
        with patch.object(archive_update, "connect", return_value=self.conn), \
             patch.object(archive_update, "closing", side_effect=nullcontext), \
             patch.object(provider, "trading_dates", return_value=(["2026-10-13"], "calendar.json")), \
             patch.object(provider, "fetch_day", side_effect=provider.ProviderError("offline")):
            live_update.refresh(":memory:", now=datetime.fromisoformat("2026-10-15T16:00:00+08:00"), stop=self.stop)
        self.assertEqual(db.date_view(self.conn, "2026-10-13")["data_status"], "ok")
        self.assertEqual(db.meta(self.conn)["auto_update_status"], "error")
        self.assertIn("offline", db.meta(self.conn)["auto_update_error"])

    def test_new_stocks_refresh_registration_even_if_existing_cache_is_fresh(self):
        db.set_settings(self.conn, registration_fetched_at=db.now_iso(), registration_requested=0)
        refresher = registration.Refresher(":memory:")
        with patch("lianban.runtime.metadata.connect", return_value=self.conn), patch("lianban.runtime.metadata.closing", side_effect=nullcontext), \
             patch("lianban.runtime.metadata.threading.Thread") as worker:
            refresher.maybe_refresh()
        worker.assert_called_once()

    def test_cls_snapshot_source_is_preserved_and_exposed_by_date_api(self):
        row = {**self.row, "date": "2026-10-15", "boards": 11, "source": provider.CLS_SOURCE}
        result = provider.DayResult("2026-10-15", [row], "ok", "synthetic", "cls.json", provider.CLS_SOURCE)
        self.run_refresh(["2026-10-13", "2026-10-15"],
                         {"2026-10-15": result, "2026-10-13": self.result("2026-10-13")},
                         now="2026-10-15T15:30:00+08:00")
        view = db.date_view(self.conn, "2026-10-15")
        self.assertEqual(view["source"], provider.CLS_SOURCE)
        self.assertEqual(view["rows"][0]["source"], provider.CLS_SOURCE)
        self.assertEqual(view["stats"]["max_boards"], 11)
        # An outage must not revise 11 boards into another feed's 1 board.
        self.run_refresh(["2026-10-13", "2026-10-15"],
                         {"2026-10-15": self.result("2026-10-15", boards=1), "2026-10-13": self.result("2026-10-13")},
                         now="2026-10-15T16:35:00+08:00")
        self.assertEqual(db.date_view(self.conn, "2026-10-15")["stats"]["max_boards"], 11)

    def test_yesterdays_cls_snapshot_is_not_overwritten_by_historical_provider(self):
        day = "2026-10-15"
        with patch("lianban.archive.service.now_iso", return_value="2026-10-15T15:30:00+08:00"):
            db.save_day(self.conn, day, [{**self.row, "date": day, "boards": 11}], provider.CLS_SOURCE)
        _, fetch = self.run_refresh(["2026-10-13", day], {"2026-10-13": self.result("2026-10-13")},
                                   now="2026-10-16T15:00:00+08:00")
        self.assertNotIn(day, [call.args[0] for call in fetch.call_args_list])
        self.assertEqual(db.date_view(self.conn, day)["stats"]["max_boards"], 11)


if __name__ == "__main__":
    unittest.main()
