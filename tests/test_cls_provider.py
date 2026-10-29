"""Current-day provider selection, date integrity, totals, and source isolation."""
from datetime import datetime
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from lianban.adapters.providers import pools as provider


class CurrentPoolTests(unittest.TestCase):
    day = "2026-10-16"
    after = datetime.fromisoformat("2026-10-16T15:30:00+08:00")

    def cls_row(self, **changes):
        return {"secu_code": "sh600001", "secu_name": "测试股份", "last_px": 11.0,
                "change": 0.1, "time": "2026-10-16 14:45:00", "num_stocks": 1,
                "limit_up_days": 11, "up_reason": "测试原因", **changes}

    def xgb_payload(self, day=None):
        day = day or self.day
        stamp = int(datetime.fromisoformat(day + "T14:45:00+08:00").timestamp())
        return {"code": 20000, "data": [{"symbol": "600001.SS", "stock_chi_name": "测试股份",
                 "limit_up_days": 1, "price": 11.0, "change_percent": 0.1,
                 "first_limit_up": stamp, "last_limit_up": stamp}]}

    def fetch(self, payloads, *, day=None, now=None):
        responses = [SimpleNamespace(json=lambda value=value: value) for value in payloads]
        with patch.object(provider, "_get", side_effect=responses) as get, \
             patch.object(provider, "_save_raw", return_value="synthetic.json"):
            result = provider.fetch_day(day or self.day, now=now or self.after)
        return result, get

    def test_cls_full_pool_keeps_continuous_boards_and_unknown_optional_fields(self):
        rows = provider.normalize_cls_pool({"code": 200, "data": [self.cls_row()]}, self.day)
        self.assertEqual(rows[0]["boards"], 11)
        self.assertEqual(rows[0]["pct_change"], 10.0)
        self.assertEqual(rows[0]["source"], provider.CLS_SOURCE)
        for field in ("first_time", "last_time", "turnover", "open_times"):
            self.assertIsNone(rows[0][field])

    def test_bad_dates_totals_duplicates_and_core_fields_reject_entire_pool(self):
        invalid = [{"time": "2026-10-15 14:45:00"}, {"time": None}, {"num_stocks": 2},
                   {"num_stocks": True}, {"limit_up_days": 0}, {"limit_up_days": 2.5},
                   {"secu_code": "600001"}, {"last_px": 0}, {"change": "NaN"},
                   {"change": "1e308"}, {"secu_name": ""}]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(provider.ProviderError):
                provider.normalize_cls_pool({"code": 200, "data": [self.cls_row(**changes)]}, self.day)
        with self.assertRaises(provider.ProviderError):
            provider.normalize_cls_pool({"code": 200, "data": [self.cls_row(num_stocks=2)] * 2}, self.day)

    def test_unknown_or_incomplete_shapes_are_rejected(self):
        for payload in [None, [], {"code": 9004, "data": []}, {"code": 200, "data": None},
                        {"code": 200, "data": {"items": []}}, {"code": 200, "data": [None]}]:
            with self.subTest(payload=payload), self.assertRaises(provider.ProviderError):
                provider.normalize_cls_pool(payload, self.day)

    def test_after_cutoff_prefers_cls_and_labels_the_source(self):
        result, get = self.fetch([{"code": 200, "data": [self.cls_row()]}])
        self.assertEqual(result.source, provider.CLS_SOURCE)
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.records[0]["boards"], 11)
        get.assert_called_once()
        self.assertEqual(get.call_args.args[0], provider.CLS_POOL_URL)

    def test_before_cutoff_and_historical_dates_only_use_dated_history(self):
        for day, now in [(self.day, "2026-10-16T15:29:59+08:00"),
                         ("2026-10-15", "2026-10-16T15:30:00+08:00")]:
            result, get = self.fetch([self.xgb_payload(day)], day=day, now=datetime.fromisoformat(now))
            self.assertEqual(result.source, provider.SOURCE)
            self.assertEqual(get.call_args.args[1], {"pool_name": "limit_up", "date": day})
            get.assert_called_once()

    def test_stale_cls_and_empty_history_use_date_verified_live_fallback(self):
        result, get = self.fetch([{"code": 200, "data": [self.cls_row(time="2026-10-15 14:45:00")]},
                                 {"code": 20000, "data": None}, self.xgb_payload()])
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.source, provider.SOURCE)
        self.assertEqual(get.call_args.args[1], {"pool_name": "limit_up"})

    def test_stale_live_fallback_never_becomes_today(self):
        with self.assertRaises(provider.ProviderError):
            self.fetch([{"code": 200, "data": []}, {"code": 20000, "data": None},
                        self.xgb_payload("2026-10-15")])

    def test_unavailable_all_sources_remains_unknown(self):
        result, _ = self.fetch([{"code": 200, "data": []}, {"code": 20000, "data": None},
                                {"code": 20000, "data": None}])
        self.assertEqual(result.status, "empty")
        self.assertEqual(result.records, [])


if __name__ == "__main__":
    unittest.main()
