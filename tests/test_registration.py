"""Province-only collection, legacy cleanup and cache atomicity."""
from contextlib import closing, nullcontext
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
import registration


class RegistrationTests(unittest.TestCase):
    def payload(self, **changes):
        row = {"SECUCODE": "002343.SZ", "SECURITY_CODE": "002343", "REGIONBK": "江西省",
               "REG_ADDRESS": "南昌经济技术开发区秀先路999号", "ADDRESS": "上海市办公地址", **changes}
        return {"success": True, "result": {"pages": 1, "count": 1, "data": [row]}}

    def record(self, **changes):
        return {"code": "002343", "province": "江西省", "city": "南昌",
                "location": "江西 · 南昌", "address": "南昌经济技术开发区秀先路999号", **changes}

    def test_only_province_is_requested_and_retained(self):
        self.assertEqual(registration.FIELDS, "SECUCODE,SECURITY_CODE,REGIONBK")
        expected = [{"code": "002343", "province": "江西省"}]
        self.assertEqual(registration.normalize_batch(self.payload(), {"002343"}), expected)
        self.assertEqual(registration.normalize_batch(self.payload(REG_ADDRESS=None), {"002343"}), expected)

    def test_province_whitelist_accepts_short_and_full_labels_only(self):
        cases = [("广西", "广西壮族自治区"), ("黑龙江省", "黑龙江省"),
                 ("上海", "上海市"), ("天津市", "天津市"), ("内蒙古", "内蒙古自治区"),
                 ("香港", "香港特别行政区"), ("广东省深圳市测试街道", ""), (None, ""), ("未知", "")]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(registration.normalize_province(value), expected)

    def test_missing_province_does_not_fall_back_to_detailed_address(self):
        for region in ("", None, "江西省南昌市测试地址"):
            with self.subTest(region=region):
                self.assertEqual(registration.normalize_batch(self.payload(REGIONBK=region), {"002343"}), [])

    def test_legacy_snapshots_are_sanitized_in_place_idempotently(self):
        payload = {"response": self.payload(), "samples": [self.record()], "count": 1}
        clean = registration.province_only_snapshot(payload)
        self.assertEqual(clean["samples"], [{"code": "002343", "province": "江西省"}])
        self.assertEqual(set(clean["response"]["result"]["data"][0]), {"SECUCODE", "SECURITY_CODE", "REGIONBK"})
        with TemporaryDirectory() as directory:
            raw = Path(directory) / "raw"
            raw.mkdir()
            snapshot = raw / "registration_legacy.json"
            snapshot.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(registration.clean_legacy_snapshots(Path(directory) / "archive.sqlite3"), 1)
            self.assertTrue(snapshot.is_file())
            self.assertEqual(json.loads(snapshot.read_text(encoding="utf-8")), clean)
            self.assertEqual(registration.clean_legacy_snapshots(Path(directory) / "archive.sqlite3"), 0)

    def test_wrong_market_duplicate_and_incomplete_page_are_rejected(self):
        for changes in ({"SECUCODE": "002343.HK"}, {"SECURITY_CODE": "600000"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                registration.normalize_batch(self.payload(**changes), {"002343"})
        for malformed in (None, [], {"success": False}, {"success": True, "result": {"data": [], "count": 1, "pages": 2}}):
            with self.subTest(payload=malformed), self.assertRaises(ValueError):
                registration.normalize_batch(malformed, {"002343"})
        payload = self.payload()
        payload["result"]["data"] *= 2
        payload["result"]["count"] = 2
        with self.assertRaises(ValueError):
            registration.normalize_batch(payload, {"002343"})

    def test_explicit_no_data_for_unsupported_historical_securities(self):
        payload = {"version": None, "result": None, "success": False, "message": "返回数据为空", "code": 9201}
        self.assertEqual(registration.normalize_batch(payload, {"832145"}), [])
        for changes in ({"code": 500}, {"success": True}, {"message": "服务器错误"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                registration.normalize_batch({**payload, **changes}, {"832145"})

    def test_registration_enrichment_does_not_change_archived_events(self):
        with closing(db.connect(":memory:")) as conn:
            db.save_day(conn, "2025-10-14", [{"code": "002343", "name": "测试股份", "boards": 1}], "synthetic")
            original = dict(conn.execute("SELECT * FROM events").fetchone())
            db.save_registrations(conn, [self.record()], "synthetic", db.now_iso(), [], 1)
            row = db.date_view(conn, "2025-10-14")["rows"][0]
            self.assertEqual(row["registered_province"], "江西省")
            self.assertTrue({"registered_location", "registered_city", "registered_address"}.isdisjoint(row))
            stored = conn.execute("SELECT province,city,location,address FROM company_registrations").fetchone()
            self.assertEqual(tuple(stored), ("江西省", "", "", ""))
            self.assertEqual(dict(conn.execute("SELECT * FROM events").fetchone()), original)

    def test_bad_snapshot_rolls_back_and_failure_keeps_registration_cache(self):
        conn = db.connect(":memory:")
        db.save_registrations(conn, [self.record()], "cached", "2025-10-14T00:00:00+08:00", [], 1)
        bad = self.record(code="600000")
        del bad["province"]
        with self.assertRaises(KeyError):
            db.save_registrations(conn, [self.record(province="广东省"), bad], "new", db.now_iso(), [], 2)
        self.assertEqual(conn.execute("SELECT province FROM company_registrations").fetchone()[0], "江西省")
        with self.assertRaises(ValueError):
            db.save_registrations(conn, [self.record(province="江西省南昌市测试地址")], "new", db.now_iso(), [], 1)
        refresher = registration.Refresher(":memory:")
        refresher.refresh_callback = lambda path: (_ for _ in ()).throw(OSError("offline"))
        with patch("industry.db.connect", return_value=conn), patch("industry.closing", side_effect=nullcontext):
            refresher._run()
        self.assertEqual(db.get_settings(conn)["registration_status"], "error")
        self.assertNotIn("industry_status", db.get_settings(conn))
        self.assertEqual(tuple(conn.execute("SELECT province,city,location,address FROM company_registrations").fetchone()), ("江西省", "", "", ""))
        conn.close()

    def test_legacy_database_is_cleaned_without_changing_other_tables(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "archive.sqlite3"
            with closing(db.connect(path)) as conn:
                db.save_day(conn, "2025-10-14", [{"code": "002343", "name": "测试股份", "boards": 1}], "synthetic")
                db.save_stock_tags(conn, "002343", ["测试标签"], 0)
                conn.execute("INSERT INTO stock_blacklist VALUES ('002343','2025-10-14')")
                record = self.record(province="江西")
                conn.execute("INSERT INTO company_registrations VALUES (?,?,?,?,?,?,?)", tuple(record[key] for key in ("code", "province", "city", "location", "address")) + ("legacy", "2025-10-14"))
                conn.execute("DELETE FROM settings WHERE key='registration_storage'")
                conn.commit()
                before = {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table}")]
                          for table in ("events", "stocks", "stock_tag_overrides", "stock_blacklist")}
            for _ in range(2):
                with closing(db.connect(path)) as conn:
                    self.assertEqual(tuple(conn.execute("SELECT province,city,location,address FROM company_registrations").fetchone()), ("江西省", "", "", ""))
                    for table, expected in before.items():
                        self.assertEqual([tuple(row) for row in conn.execute(f"SELECT * FROM {table}")], expected)
                    self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_refresh_does_not_save_raw_responses(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "archive.sqlite3"
            with closing(db.connect(path)) as conn:
                db.save_day(conn, "2025-10-14", [{"code": "002343", "name": "测试股份", "boards": 1}], "synthetic")
            with patch("registration._fetch_batch", return_value=[self.record()]):
                self.assertEqual(registration.refresh(path), 1)
            self.assertFalse((Path(directory) / "raw").exists())
            with closing(db.connect(path)) as conn:
                self.assertEqual(tuple(conn.execute("SELECT province,city,location,address FROM company_registrations").fetchone()), ("江西省", "", "", ""))
                self.assertEqual(db.get_settings(conn)["registration_raw_paths"], [])


if __name__ == "__main__":
    unittest.main()
