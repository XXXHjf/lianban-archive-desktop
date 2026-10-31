"""Exchange closures, unknown coverage and business-date projections."""
from datetime import datetime
from unittest.mock import patch
import unittest
import requests
from lianban.core.clock import TZ
from lianban.core.trading_calendar import is_trading_day, latest_trading_day, bundled_closed_dates
from lianban.adapters.providers.exchange_calendar import parse_calendar
from lianban.ingestion.trading_calendar import refresh
from lianban.storage import initialize
from lianban.storage.settings import get_settings, set_settings
from lianban.storage.trading_calendar import context
from lianban.archive.service import save_day
from lianban.readside.shareholders import stock_view
from lianban.interfaces.http import routes
from types import SimpleNamespace


ANNUAL = """<h2>2026年休市安排</h2>
元旦：1月1日（星期四）至1月3日（星期六）休市，1月5日照常开市。
春节：2月15日（星期日）至2月23日（星期一）休市。
清明节：4月4日（星期六）至4月6日（星期一）休市。
劳动节：5月1日（星期五）至5月5日（星期二）休市。
端午节：6月19日（星期五）至6月21日（星期日）休市。
中秋节：9月25日（星期五）至9月27日（星期日）休市。
国庆节：10月1日（星期四）至10月7日（星期三）休市。
"""


class TradingCalendarTests(unittest.TestCase):
    def test_weekends_and_compensatory_workdays_stay_closed(self):
        for day in ("2026-10-31", "2026-11-01", "2026-10-10", "2026-02-28"):
            self.assertFalse(is_trading_day(day))
        self.assertEqual(latest_trading_day("2026-11-01"), "2026-10-30")

    def test_holiday_boundaries_and_cross_year(self):
        for day in ("2026-02-16", "2026-09-25", "2026-10-07"):
            self.assertFalse(is_trading_day(day))
        self.assertTrue(is_trading_day("2026-10-08"))
        self.assertEqual(latest_trading_day("2026-10-07"), "2026-09-30")
        self.assertEqual(latest_trading_day("2026-01-04"), "2025-12-31")

    def test_unknown_year_requires_positive_evidence(self):
        self.assertIsNone(is_trading_day("2027-01-04"))
        self.assertTrue(is_trading_day("2027-01-04", known_dates={"2027-01-04"}))
        self.assertFalse(is_trading_day("2027-01-02", known_dates={"2027-01-02"}))

    def test_parse_full_annual_table_and_reject_partial_or_bad_pages(self):
        result = parse_calendar(ANNUAL)
        self.assertEqual(result["year"], 2026)
        self.assertEqual(set(result["closed_dates"]), bundled_closed_dates(2026))
        for html in ("<h1>访问被拒绝</h1>", ANNUAL[:160], ANNUAL + "<h2>2027年休市安排</h2>"):
            with self.assertRaises(ValueError):
                parse_calendar(html)


class CalendarCompositionTests(unittest.TestCase):
    def setUp(self):
        self.conn = initialize(":memory:")

    def tearDown(self):
        self.conn.close()

    def test_weekend_shareholder_baseline_uses_friday_confirmed_pool(self):
        save_day(self.conn, "2026-10-30", [{"code": "001219", "name": "青岛食品", "boards": 5}], "fixture")
        result = stock_view(self.conn, "001219", now=datetime(2026, 10, 31, 12, tzinfo=TZ))
        self.assertEqual(result["today"], "2026-10-30")
        self.assertEqual(result["today_status"], "confirmed")
        self.assertFalse(result["today_stale"])

    def test_missing_session_remains_missing_instead_of_backdating(self):
        save_day(self.conn, "2026-10-29", [{"code": "001219", "name": "青岛食品", "boards": 4}], "fixture")
        result = stock_view(self.conn, "001219", now=datetime(2026, 10, 31, 12, tzinfo=TZ))
        self.assertEqual(result["today"], "2026-10-30")
        self.assertEqual(result["today_status"], "unavailable")

    def test_calendar_is_distinct_from_archive_coverage_and_filters_bogus_weekends(self):
        set_settings(self.conn, calendar_dates=["2024-12-31", "2026-10-31"])
        result = context(self.conn, now=datetime(2026, 10, 31, 12, tzinfo=TZ))
        self.assertIn("2024-12-31", result["dates"])
        self.assertIn("2026-10-30", result["dates"])
        self.assertNotIn("2026-10-31", result["dates"])
        self.assertNotIn("2026-10-07", result["dates"])

    def test_default_query_uses_latest_session_and_rejects_direct_holiday_requests(self):
        from lianban.archive.queries import meta
        from lianban.storage import connect
        save_day(self.conn, "2026-09-29", [{"code": "001219", "name": "青岛食品", "boards": 4}], "fixture")
        now = datetime(2026, 10, 7, 12, tzinfo=TZ)
        def copied(_):
            connection = connect(":memory:")
            self.conn.backup(connection)
            return connection
        server = SimpleNamespace(db_path=":memory:", read_only=True)
        with patch.object(routes, "connect", side_effect=copied), patch.object(routes, "meta", side_effect=lambda conn: meta(conn, now=now)):
            result = routes.read_api(server, "/api/date")
            self.assertEqual(result["date"], "2026-09-30")
            self.assertEqual(result["data_status"], "missing")
            with self.assertRaisesRegex(ValueError, "休市"):
                routes.read_api(server, "/api/date?date=2026-10-07")

    @patch("lianban.adapters.providers.exchange_calendar.fetch_calendar")
    def test_failed_refresh_keeps_cache_and_is_throttled(self, fetch):
        cached = {"2027": {"closed_dates": ["2027-01-01"], "source": "fixture"}}
        set_settings(self.conn, exchange_calendars=cached)
        fetch.side_effect = requests.ConnectionError("offline")
        now = datetime(2026, 10, 31, 12, tzinfo=TZ)
        refresh(self.conn, now=now)
        refresh(self.conn, now=now)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(get_settings(self.conn)["exchange_calendars"], cached)
        self.assertEqual(context(self.conn, now=now)["latest_trade_date"], "2026-10-30")

    @patch("lianban.adapters.providers.exchange_calendar.fetch_calendar")
    def test_next_year_calendar_is_merged_without_discarding_previous_year(self, fetch):
        fetch.return_value = {"year": 2027, "closed_dates": ["2027-01-01"], "source": "fixture"}
        refresh(self.conn, now=datetime(2026, 12, 30, 12, tzinfo=TZ))
        result = context(self.conn, now=datetime(2027, 1, 3, 12, tzinfo=TZ))
        self.assertTrue(result["year_confirmed"])
        self.assertEqual(result["latest_trade_date"], "2026-12-31")
        self.assertIn("2027-01-04", result["dates"])


if __name__ == "__main__":
    unittest.main()
