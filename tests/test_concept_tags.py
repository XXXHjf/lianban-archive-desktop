"""Source identity, strict intersections, resumable fetching and user edit isolation."""
from contextlib import closing, nullcontext
from datetime import datetime, timedelta
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lianban.profiles import concepts as concepts
import database as db


class ConceptSourceTests(unittest.TestCase):
    def test_ths_reads_regular_and_other_concepts_without_scraping_explanations(self):
        raw = ('<title>测试(000001) 概念题材_F10</title><table class="gnContent">'
               '<tr><td>1</td><td class="gnName">机器人概念</td><td>人工智能</td></tr>'
               '<tr><td>2</td><td class="gnStockList">IPv6</td></tr></table>').encode("gb18030")
        self.assertEqual(concepts.parse_ths(raw, "000001"), ["机器人概念", "IPv6"])
        with self.assertRaises(ValueError):
            concepts.parse_ths(raw, "000002")
        with self.assertRaises(ValueError):
            concepts.parse_ths(b"<title>verification</title>", "000001")
        with self.assertRaises(concepts.SourceUnavailable):
            concepts.parse_ths('<title>测试(000001) 概念题材</title>'.encode("gb18030"), "000001")

    def test_cls_checks_security_identity_and_distinguishes_no_profile_from_bad_payload(self):
        payload = {"code": 200, "data": {"quote": {"secu_code": "sz000001"}, "plate": [{"secu_name": "银行"}]}}
        self.assertEqual(concepts.parse_cls(payload, "000001"), ["银行"])
        with self.assertRaises(ValueError):
            concepts.parse_cls(payload, "600001")
        with self.assertRaises(ValueError):
            concepts.parse_cls({"code": 500, "data": {}}, "000001")
        with self.assertRaises(concepts.SourceUnavailable):
            concepts.parse_cls({"code": 200, "data": {"quote": None, "plate": []}}, "000001")

    def test_intersection_normalizes_spelling_but_never_guesses_related_topics(self):
        ths = ["机器人概念", "5G", "IPv6", "机器人", "新型工业化", "动力电池回收", "昨日涨停", "安徽", "百日新高", "深圳本地"]
        cls = ["机器人", "5G产业链", "ipv6", "智能制造", "电池回收", "昨日涨停", "安徽", "百日新高", "深圳本地"]
        self.assertEqual(concepts.common_tags(ths, cls), ["机器人", "5G", "IPv6"])
        self.assertEqual(concepts.common_tags(["海工装备"], ["工程机械"]), [])

    def test_valid_cache_avoids_network_and_failure_keeps_the_last_snapshot(self):
        root = Path(__file__).parent / "test-data" / ("concept-cache-" + uuid4().hex)
        directory = root / "ths"
        directory.mkdir(parents=True)
        saved = {"code": "000001", "source": "ths", "status": "ok", "tags": ["银行"], "fetched_at": db.now_iso()}
        cache = directory / "000001.json"
        cache.write_text(json.dumps(saved), encoding="utf-8")
        with patch.object(concepts, "_get", side_effect=OSError("offline")) as fetch:
            self.assertEqual(concepts.source_snapshot(root, "ths", "000001")["tags"], ["银行"])
            fetch.assert_not_called()
            with self.assertRaises(OSError):
                concepts.source_snapshot(root, "ths", "000001", force=True)
        self.assertEqual(json.loads(cache.read_text(encoding="utf-8")), saved)

    def test_restricted_source_stops_queued_work_instead_of_hammering_it(self):
        import threading
        stop = threading.Event()
        with patch.object(concepts, "source_snapshot", side_effect=concepts.SourceRestricted("限制访问")) as fetch:
            self.assertEqual(concepts.collect_stock(Path("unused"), "000001", stop=stop)["status"], "deferred")
            self.assertTrue(stop.is_set())
            self.assertEqual(concepts.collect_stock(Path("unused"), "000002", stop=stop)["status"], "deferred")
            self.assertEqual(fetch.call_count, 1)

    def test_access_restrictions_have_bounded_delayed_retries(self):
        response = requests.Response()
        response.status_code = 429
        response.headers["Retry-After"] = "120"
        previous = dict(concepts._interval)
        try:
            with patch.object(concepts, "_get_once", side_effect=requests.HTTPError(response=response)) as fetch:
                with self.assertRaises(concepts.SourceRestricted):
                    concepts._get("ths", "000001")
                self.assertEqual(fetch.call_count, 3)
                self.assertGreater(concepts._next_request["ths"], concepts.time.monotonic() + 100)
        finally:
            concepts._interval.update(previous)
            concepts._next_request.clear()
            concepts._denial_streak.update(ths=0, cls=0)

    def test_isolated_forbidden_security_does_not_stop_other_securities(self):
        response = requests.Response()
        response.status_code = 403
        try:
            with patch.object(concepts, "_get_once", side_effect=[requests.HTTPError(response=response), b"valid"]):
                with self.assertRaises(requests.HTTPError):
                    concepts._get("ths", "000001")
                self.assertEqual(concepts._get("ths", "000002"), b"valid")
                self.assertEqual(concepts._denial_streak["ths"], 0)
        finally:
            concepts._denial_streak.update(ths=0, cls=0)


class ConceptDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.initialize(":memory:")
        db.save_day(self.conn, "2026-10-21", [
            {"code": "000001", "name": "测试一", "boards": 2},
            {"code": "600001", "name": "测试二", "boards": 1}], "synthetic")
        db.save_industries(self.conn, [{"code": "000001", "industry": "旧行业", "industry_level2": "",
            "industry_level3": "", "industry_code": "000001", "effective_from": "2021-01-01",
            "source_updated_at": "2026-10-21"}], "synthetic", db.now_iso(), [])

    def tearDown(self):
        self.conn.close()

    def record(self, code="000001", tags=None):
        tags = ["机器人", "风电"] if tags is None else tags
        return {"code": code, "tags": tags, "ths_tags": tags, "cls_tags": tags, "fetched_at": db.now_iso()}

    def test_default_refresh_never_overwrites_custom_tags_notes_blacklist_or_history(self):
        db.save_stock_tags(self.conn, "000001", ["我的标签", "保留原顺序"], 0)
        db.save_stock_note(self.conn, "000001", "我的备注", 0)
        db.save_blacklist(self.conn, "000001", "add")
        tables = ("stock_tag_overrides", "stock_notes", "stock_blacklist", "events")
        before = {t: [tuple(r) for r in self.conn.execute(f"SELECT * FROM {t}")] for t in tables}
        db.save_default_tags(self.conn, [self.record()], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        for t in tables:
            self.assertEqual([tuple(r) for r in self.conn.execute(f"SELECT * FROM {t}")], before[t])
        current = db.get_stock_tags(self.conn, "000001")
        self.assertEqual(current["tags"], ["我的标签", "保留原顺序", "机器人", "风电"])
        self.assertEqual(current["source_tags"], ["机器人", "风电"])
        self.assertEqual(current["revision"], 1)
        restored = db.save_stock_tags(self.conn, "000001", [], 1, use_source=True)
        self.assertEqual(restored["tags"], ["机器人", "风电"])
        self.assertFalse(restored["customized"])
        row = db.date_view(self.conn, "2026-10-21")["rows"][0]
        self.assertEqual(row["tags"], ["机器人", "风电"])
        self.assertEqual(row["note"], "我的备注")
        self.assertTrue(row["blacklisted"])

    def test_empty_intersection_and_missing_sources_cannot_fall_back_to_unshared_industry(self):
        db.save_default_tags(self.conn, [self.record(tags=[])], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        for code in ("000001", "600001"):
            self.assertEqual(db.get_stock_tags(self.conn, code)["tags"], [])
        db.save_stock_tags(self.conn, "600001", [], 0)
        db.save_default_tags(self.conn, [self.record("600001")], concepts.SOURCE)
        self.assertEqual(db.get_stock_tags(self.conn, "600001")["tags"], ["机器人", "风电"], "new defaults join existing custom tags")

    def test_merged_tags_deduplicate_in_user_order_across_daily_profile_and_blacklist(self):
        db.save_stock_tags(self.conn, "000001", ["风电", "AI", "我的标签"], 0)
        before = tuple(self.conn.execute("SELECT * FROM stock_tag_overrides WHERE code='000001'").fetchone())
        db.save_default_tags(self.conn, [self.record(tags=["机器人", "风电", "ai"])], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        expected = ["风电", "AI", "我的标签", "机器人"]
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], expected)
        self.assertEqual(db.date_view(self.conn, "2026-10-21")["rows"][0]["tags"], expected)
        self.assertEqual(db.stock_view(self.conn, "000001", "2026-10-21", "2026-10-21")["stock"]["tags"], expected)
        db.save_blacklist(self.conn, "000001", "add")
        self.assertEqual(db.get_blacklist(self.conn)["rows"][0]["tags"], expected)
        self.assertEqual(tuple(self.conn.execute("SELECT * FROM stock_tag_overrides WHERE code='000001'").fetchone()), before)

    def test_editing_merged_tags_retains_explicit_removals_without_promoting_defaults(self):
        db.save_stock_tags(self.conn, "000001", ["我的标签"], 0)
        db.save_default_tags(self.conn, [self.record()], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        edited = db.save_stock_tags(self.conn, "000001", ["我的标签", "机器人", "新标签"], 1)
        self.assertEqual(edited["tags"], ["我的标签", "新标签", "机器人"])
        self.assertEqual(edited["custom_tags"], ["我的标签", "新标签"])
        self.assertEqual(edited["excluded_tags"], ["风电"])
        db.save_default_tags(self.conn, [self.record(tags=["风电", "机器人", "新概念"])], concepts.SOURCE)
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], ["我的标签", "新标签", "机器人", "新概念"])
        cleared = db.save_stock_tags(self.conn, "000001", [], 2)
        self.assertEqual(cleared["tags"], [])
        self.assertEqual(db.date_view(self.conn, "2026-10-21")["rows"][0]["tags"], [])
        self.assertEqual(db.save_stock_tags(self.conn, "000001", [], 3, use_source=True)["tags"], ["风电", "机器人", "新概念"])

    def test_manual_tags_that_overlap_defaults_stay_when_the_source_changes(self):
        db.save_stock_tags(self.conn, "000001", ["风电", "我的标签"], 0)
        db.save_default_tags(self.conn, [self.record()], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        db.save_stock_tags(self.conn, "000001", ["风电", "我的标签", "机器人"], 1)
        db.save_default_tags(self.conn, [self.record(tags=["新概念"])], concepts.SOURCE)
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], ["风电", "我的标签", "新概念"])

    def test_default_suppression_survives_absence_and_unrelated_edits(self):
        db.save_default_tags(self.conn, [self.record()], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        db.save_stock_tags(self.conn, "000001", ["机器人"], 0)
        db.save_default_tags(self.conn, [self.record(tags=["机器人"])], concepts.SOURCE)
        db.save_stock_tags(self.conn, "000001", ["机器人", "自定义"], 1)
        db.save_default_tags(self.conn, [self.record()], concepts.SOURCE)
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"], ["自定义", "机器人"])

    def test_combined_list_can_exceed_twenty_while_custom_additions_remain_bounded(self):
        tags = [f"概念{i}" for i in range(18)]
        custom = [f"自定义{i}" for i in range(10)]
        db.save_stock_tags(self.conn, "000001", custom, 0)
        db.save_default_tags(self.conn, [self.record(tags=tags)], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        combined = db.get_stock_tags(self.conn, "000001")["tags"]
        self.assertEqual(len(combined), 28)
        self.assertEqual(db.save_stock_tags(self.conn, "000001", combined + ["再加一个"], 1)["tags"], custom + ["再加一个"] + tags)

    def test_invalid_default_write_rolls_back_the_entire_batch(self):
        db.save_default_tags(self.conn, [self.record()], concepts.SOURCE)
        bad = self.record("600001")
        del bad["cls_tags"]
        with self.assertRaises(KeyError):
            db.save_default_tags(self.conn, [self.record(tags=["变化"]), bad], concepts.SOURCE)
        self.assertEqual(json.loads(self.conn.execute("SELECT tags_json FROM stock_default_tags").fetchone()[0]), ["机器人", "风电"])

    def test_large_verified_default_list_can_be_restored_and_edited_without_truncation(self):
        tags = [f"概念{i}" for i in range(25)]
        db.save_default_tags(self.conn, [self.record(tags=tags)], concepts.SOURCE)
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        self.assertEqual(db.save_stock_tags(self.conn, "000001", tags, 0)["tags"], tags)
        self.assertEqual(db.save_stock_tags(self.conn, "000001", [], 1, use_source=True)["tags"], tags)

    def test_batch_refresh_reuses_verified_defaults_after_fetch_errors(self):
        root = Path(__file__).parent / "test-data" / ("concept-batch-" + uuid4().hex)
        root.mkdir(parents=True)
        path = root / "archive.sqlite3"
        with closing(db.initialize(path)) as conn:
            db.save_day(conn, "2026-10-21", [{"code": "000001", "name": "样本", "boards": 1}], "synthetic")
            db.save_stock_tags(conn, "000001", ["保留"], 0)
            db.save_default_tags(conn, [self.record()], concepts.SOURCE)
        with patch.object(concepts, "collect_stock", return_value={"code": "000001", "status": "error", "error": "offline"}):
            report = concepts.refresh(path)
        self.assertEqual(report["errors"], 1)
        with closing(db.initialize(path)) as conn:
            tags = db.get_stock_tags(conn, "000001")
            self.assertEqual(tags["tags"], ["保留", "机器人", "风电"])
            self.assertEqual(tags["source_tags"], ["机器人", "风电"])
            self.assertEqual(db.get_settings(conn)["concept_status"], "partial")

    def test_partial_refresh_waits_an_hour_and_new_stocks_trigger_supplement(self):
        from lianban.runtime import metadata
        from lianban.profiles import industry
        conn = self.conn
        refresher = concepts.Refresher(":memory:")
        db.set_settings(conn, concept_fetched_at=db.now_iso(), concept_errors=1, concept_requested=2)
        with patch.object(metadata, "connect", return_value=conn), patch.object(metadata, "closing", side_effect=nullcontext), \
                patch.object(metadata.threading, "Thread") as worker:
            refresher.maybe_refresh()
            worker.assert_not_called()
            db.set_settings(conn, concept_fetched_at=(datetime.now(db.TZ) - timedelta(hours=2)).isoformat())
            refresher.maybe_refresh()
            worker.assert_called_once()
            refresher._running = False
            worker.reset_mock()
            db.set_settings(conn, concept_fetched_at=db.now_iso(), concept_errors=0, concept_requested=1)
            refresher.maybe_refresh()
            worker.assert_called_once()


if __name__ == "__main__":
    unittest.main()
