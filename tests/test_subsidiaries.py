"""THS subsidiary evidence, first-view caching and failure preservation."""
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import URLError
import unittest

from lianban.core.clock import TZ
from lianban.profiles import subsidiaries as subs
from lianban.storage import initialize
from lianban.storage.subsidiaries import save_profile
from lianban.storage.transaction import transaction


HEADERS = ["序号", "关联公司名称", "参控关系", "参控比例", "投资金额(元)", "被参控公司净利润(元)", "是否报表合并", "被参股公司主营业务"]


def html(rows=(), *, count=None, code="000001", day="2026-09-30"):
    def tr(cells):
        return "<tr>" + "".join(f"<td>{value}</td>" for value in cells) + "</tr>"
    return (f"<title>示例({code})公司</title><table id='ckg_table'><caption>参股或控股公司："
            f"{len(rows) if count is None else count}家 最新公告日期：{day}</caption>"
            + tr(HEADERS) + "".join(tr(row) for row in rows) + "</table>")


class SubsidiaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "profiles.sqlite3"
        self.conn = initialize(self.path)
        self.addCleanup(self.conn.close)
        with transaction(self.conn):
            self.conn.execute("INSERT INTO stocks VALUES ('000001','示例','SZ','2026-10-30')")
        self.now = datetime(2026, 10, 31, 10, 30, tzinfo=TZ)
        self.companies = [{"name": "示例子公司", "relation": "全资子公司", "holding_ratio": "100%", "business": "设备制造"}]

    def view(self, **kwargs):
        return subs.stock_view(self.path, "000001", now=kwargs.pop("now", self.now), **kwargs)

    def test_html_preserves_only_disclosed_subsidiaries_and_businesses(self):
        rows = [["1", "子公司A", "全资子公司", "100%", "123", "456", "是", "设备&amp;服务"],
                ["2", "参股公司", "参股公司", "10%", "0", "0", "否", "业务"],
                ["3", "孙公司B", "孙公司", "--", "0", "0", "是", "未披露"]]
        day, companies = subs.normalize_html(html(rows), "000001", "2026-10-31")
        self.assertEqual(day, "2026-09-30")
        self.assertEqual(companies, [
            {"name": "子公司A", "relation": "全资子公司", "holding_ratio": "100%", "business": "设备&服务"},
            {"name": "孙公司B", "relation": "孙公司", "holding_ratio": "", "business": ""}])

    def test_source_mismatch_future_or_incomplete_tables_fail(self):
        row = ["1", "A", "子公司", "50%", "0", "0", "是", "业务"]
        for value in [html([row], code="000002"), html([row], count=2), html([row], day="2027-01-01"),
                      html([row, ["malformed"]], count=1), html([row]).replace("关联公司名称", "改版字段")]:
            with self.subTest(html=value), self.assertRaises(ValueError):
                subs.normalize_html(value, "000001", "2026-10-31")
        self.assertEqual(subs.normalize_html(html(), "000001", "2026-10-31")[1], [])

    def test_refresh_false_is_read_only_and_does_not_fetch_or_initialize(self):
        with patch.object(subs, "fetch") as fetch:
            before = self.path.read_bytes()
            self.assertEqual(self.view(refresh=False)["status"], "empty")
            self.assertEqual(self.path.read_bytes(), before)
            self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM subsidiary_profiles").fetchone()[0], 0)
            fetch.assert_not_called()

    def test_first_view_caches_and_expires_at_24_hours(self):
        with patch.object(subs, "fetch", return_value=("2026-09-30", self.companies)) as fetch:
            first = self.view()
            self.assertEqual(first["rows"], self.companies)
            self.assertEqual(first["source_url"], "https://basic.10jqka.com.cn/000001/company.html")
            self.assertEqual(first["status"], "current")
            self.view(now=self.now + timedelta(hours=23, minutes=59))
            self.assertEqual(fetch.call_count, 1)
            self.view(now=self.now + timedelta(hours=24))
            self.assertEqual(fetch.call_count, 2)

    def test_failed_first_fetch_waits_15_minutes_before_retry(self):
        with patch.object(subs, "fetch", side_effect=URLError("source unavailable")) as fetch:
            self.assertEqual(self.view()["status"], "error")
            self.view(now=self.now + timedelta(minutes=14, seconds=59))
            self.assertEqual(fetch.call_count, 1)
            self.view(now=self.now + timedelta(minutes=15))
            self.assertEqual(fetch.call_count, 2)
        with patch.object(subs, "fetch", return_value=("2026-09-30", [])):
            self.assertEqual(self.view(now=self.now + timedelta(minutes=30))["status"], "current")

    def test_failed_refresh_keeps_previous_rows_date_and_source(self):
        old = self.now - timedelta(days=2)
        save_profile(self.conn, "000001", "2026-09-30", self.companies, old.isoformat(timespec="seconds"))
        with patch.object(subs, "fetch", side_effect=TimeoutError("timeout")):
            view = self.view()
        self.assertEqual(view["status"], "error")
        self.assertEqual(view["rows"], self.companies)
        self.assertEqual(view["fetched_at"], old.isoformat(timespec="seconds"))
        self.assertEqual(view["disclosure_date"], "2026-09-30")

    def test_response_connection_reset_returns_persisted_cache_on_first_view(self):
        old = self.now - timedelta(days=2)
        save_profile(self.conn, "000001", "2026-09-30", self.companies, old.isoformat(timespec="seconds"))
        with patch.object(subs, "fetch", side_effect=ConnectionResetError("response interrupted")):
            view = self.view()
        self.assertEqual(view["status"], "error")
        self.assertEqual(view["rows"], self.companies)
        self.assertEqual(view["fetched_at"], old.isoformat(timespec="seconds"))

    def test_regressing_or_missing_disclosure_cannot_replace_cached_rows(self):
        old = self.now - timedelta(days=2)
        save_profile(self.conn, "000001", "2026-09-30", self.companies, old.isoformat(timespec="seconds"))
        for index, day in enumerate(("2026-06-30", None)):
            with patch.object(subs, "fetch", return_value=(day, [])):
                view = self.view(now=self.now + timedelta(minutes=15 * index))
            self.assertEqual(view["status"], "error")
            self.assertEqual(view["rows"], self.companies)
        self.assertIn("日期倒退", self.conn.execute("SELECT error FROM subsidiary_profiles").fetchone()[0])

    def test_storage_rechecks_concurrent_disclosure_and_outer_rollback(self):
        stamp = self.now.isoformat(timespec="seconds")
        save_profile(self.conn, "000001", "2026-10-30", self.companies, stamp)
        with self.assertRaises(ValueError):
            save_profile(self.conn, "000001", "2026-09-30", [], stamp)
        with self.assertRaises(RuntimeError):
            with transaction(self.conn):
                save_profile(self.conn, "000001", "2026-10-31", [], stamp)
                raise RuntimeError("outer rollback")
        self.assertEqual(self.conn.execute("SELECT disclosure_date FROM subsidiary_profiles").fetchone()[0], "2026-10-30")

    def test_unknown_or_invalid_codes_do_not_fetch(self):
        with patch.object(subs, "fetch") as fetch:
            for code in ("../x", "000002", None, 1):
                with self.subTest(code=code), self.assertRaises(ValueError):
                    subs.stock_view(self.path, code)
            fetch.assert_not_called()
