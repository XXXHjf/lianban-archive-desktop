"""Industry attribution, update failures and refresh deduplication."""
from contextlib import closing, nullcontext
from pathlib import Path
import sys
import ssl
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
from lianban.runtime import metadata
from lianban.profiles import industry


class IndustryTests(unittest.TestCase):
    def test_download_completes_issuer_without_disabling_root_or_hostname_checks(self):
        context = ssl.create_default_context()
        context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"\xd0\xcf\x11\xe0synthetic-xls"
        with patch("truststore.SSLContext", return_value=context), patch.object(industry, "urlopen", return_value=response) as opened:
            industry._download(industry.DICTIONARY_URL)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertFalse(context.verify_flags & ssl.VERIFY_X509_PARTIAL_CHAIN)
        self.assertIs(opened.call_args.kwargs["context"], context)
        self.assertTrue(any(cert["subject"][-1][0][1] == "GeoTrust G2 TLS CN RSA4096 SHA256 2022 CA1"
                            for cert in context.get_ca_certs()))

    def record(self, **changes):
        return {"code": "000001", "industry": "银行", "industry_level2": "国有大型银行Ⅱ",
                "industry_level3": "国有大型银行Ⅲ", "industry_code": "480101",
                "effective_from": "2021-01-01", "source_updated_at": "2026-10-01", **changes}

    def test_latest_effective_classification_ignores_future_changes(self):
        dictionary = {"480101": ["银行", "", ""], "720101": ["传媒", "", ""]}
        rows = [("000001", "2025-01-01", "480101", "2025-01-01"),
                ("000001", "2027-01-01", "720101", "2026-10-01")]
        result = industry.select_current(rows, dictionary, "2026-10-15")
        self.assertEqual(result[0]["industry"], "银行")
        self.assertEqual(result[0]["code"], "000001")

    def test_latest_change_and_missing_dictionary_never_reuse_older_industry(self):
        rows = [("000001", "2024-01-01", "480101", "2024-01-01"),
                ("000001", "2025-01-01", "720101", "2025-01-01")]
        self.assertEqual(industry.select_current(rows, {"480101": ["银行", "", ""]}, "2026-10-15"), [])

    def test_conflicting_assignments_are_rejected(self):
        rows = [("000001", "2025-01-01", code, "2025-01-01") for code in ("480101", "720101")]
        with self.assertRaises(ValueError):
            industry.select_current(rows, {}, "2026-10-15")

    def test_current_industries_do_not_rewrite_historical_events(self):
        with closing(db.initialize(":memory:")) as conn:
            db.save_day(conn, "2025-10-14", [{"code": "000001", "name": "测试股", "boards": 1}], "synthetic")
            db.save_industries(conn, [self.record()], "synthetic-current", db.now_iso(), [])
            row = db.date_view(conn, "2025-10-14")["rows"][0]
            self.assertEqual(row["industry"], "银行")
            self.assertEqual(row["industry_source"], "synthetic-current")
            self.assertIsNone(conn.execute("SELECT industry FROM events").fetchone()[0])

    def test_failed_snapshot_commit_preserves_old_cache(self):
        with closing(db.initialize(":memory:")) as conn:
            db.save_industries(conn, [self.record()], "first", "2026-10-14T00:00:00+08:00", [])
            bad = self.record(code="600000")
            del bad["industry"]
            with self.assertRaises(KeyError):
                db.save_industries(conn, [self.record(industry="传媒"), bad], "second", db.now_iso(), [])
            self.assertEqual(conn.execute("SELECT industry FROM stock_industries").fetchone()[0], "银行")
            self.assertEqual(db.get_settings(conn)["industry_source"], "first")

    def test_failed_network_update_keeps_cache_and_sets_retry_delay(self):
        # In-memory SQLite avoids creating or deleting any test directories.
        conn = db.initialize(":memory:")
        db.save_industries(conn, [self.record()], "cached", "2025-10-14T00:00:00+08:00", [])
        refresher = industry.Refresher(":memory:")
        with patch.object(refresher, "refresh_callback", side_effect=OSError("offline")), \
             patch.object(metadata, "connect", return_value=conn), \
             patch.object(metadata, "closing", side_effect=nullcontext):
            refresher._run()
        self.assertEqual(conn.execute("SELECT industry FROM stock_industries").fetchone()[0], "银行")
        self.assertEqual(db.get_settings(conn)["industry_status"], "error")
        self.assertGreater(refresher._retry_after, 0)
        conn.close()

    def test_fresh_cache_and_in_progress_update_do_not_spawn_workers(self):
        conn = db.initialize(":memory:")
        db.set_settings(conn, industry_fetched_at=db.now_iso())
        refresher = industry.Refresher(":memory:")
        with patch.object(metadata, "connect", return_value=conn), \
             patch.object(metadata, "closing", side_effect=nullcontext), \
             patch.object(metadata.threading, "Thread") as worker:
            refresher.maybe_refresh()
            worker.assert_not_called()
            refresher._running = True
            refresher.maybe_refresh()
            worker.assert_not_called()
        conn.close()


if __name__ == "__main__":
    unittest.main()
