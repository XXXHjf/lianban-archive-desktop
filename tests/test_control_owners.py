"""Display-only controls, source validation and atomic cache replacement."""
from contextlib import closing
from datetime import datetime, timedelta
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

from lianban.core.clock import TZ
from lianban.profiles import control_owners as controls
from lianban.readside.control_owners import stock_view
from lianban.storage import connect, initialize
from lianban.storage.control_owners import save_batch
from lianban.storage.transaction import transaction


def source_row(code="000001", **fields):
    return {"SECUCODE": controls.secucode(code), "SECURITY_CODE": code,
            "CONTROL_HOLDER": "示例公司", "CONTROL_HOLDER_CODE": "1234",
            "REAL_CONTROLER": "张三、李四", "REAL_CONTROLER_CODE": "张三、李四", **fields}


def page(rows, pages=1, count=None):
    return {"success": True, "result": {"data": rows, "pages": pages, "count": len(rows) if count is None else count}}


class ControlOwnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "profiles.sqlite3"
        self.conn = initialize(self.path)
        self.addCleanup(self.conn.close)
        with transaction(self.conn):
            self.conn.executemany("INSERT INTO stocks VALUES (?,?,?,?)",
                                  [(code, "示例", "SZ", "2026-10-30") for code in ("000001", "000002")])

    def test_name_separators_and_parenthesized_commas(self):
        records, found, pages, count = controls.normalize_page(page([source_row(
            CONTROL_HOLDER="示例(上海,浦东)公司、另一机构", CONTROL_HOLDER_CODE="123、456")]), {"000001"})
        self.assertEqual((found, pages, count), ({"000001"}, 1, 1))
        self.assertEqual([r["holder_name"] for r in records], ["示例(上海,浦东)公司", "另一机构", "张三", "李四"])
        self.assertEqual([r["holder_type"] for r in records], ["控股机构", "控股机构", "个人", "个人"])

    def test_one_numeric_identifier_preserves_english_company_comma(self):
        records, *_ = controls.normalize_page(page([source_row(CONTROL_HOLDER="COFCO Co., Ltd.")]), {"000001"})
        self.assertEqual(records[0]["holder_name"], "COFCO Co., Ltd.")

    def test_display_only_without_hardcoded_parent(self):
        records, found, *_ = controls.normalize_page(page([source_row(
            CONTROL_HOLDER="青岛华通国有资本投资运营集团有限公司", REAL_CONTROLER=None, REAL_CONTROLER_CODE=None)]), {"000001"})
        save_batch(self.conn, ["000001"], records, found)
        self.assertEqual([r["kind"] for r in stock_view(self.conn, "000001")["rows"]], ["controller"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM stock_shareholders").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM stock_tag_overrides").fetchone()[0], 0)

    def test_null_and_empty_fields_are_valid_but_bad_types_or_missing_fields_fail(self):
        records, found, *_ = controls.normalize_page(page([source_row(
            CONTROL_HOLDER=None, CONTROL_HOLDER_CODE=None, REAL_CONTROLER="无实际控制人", REAL_CONTROLER_CODE="")]), {"000001"})
        self.assertEqual((records, found), ([], {"000001"}))
        for field in ("CONTROL_HOLDER", "CONTROL_HOLDER_CODE", "REAL_CONTROLER", "REAL_CONTROLER_CODE"):
            for invalid in (123, [], {}):
                with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                    controls.normalize_page(page([source_row(**{field: invalid})]), {"000001"})
            row = source_row()
            del row[field]
            with self.assertRaises(ValueError):
                controls.normalize_page(page([row]), {"000001"})

    def test_mismatched_names_and_identifiers_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "数量不符"):
            controls.normalize_page(page([source_row(CONTROL_HOLDER="甲、乙", CONTROL_HOLDER_CODE="123")]), {"000001"})

    def test_pagination_is_complete_and_duplicate_free(self):
        def fetch(payloads):
            responses = [io.BytesIO(json.dumps(p).encode()) for p in payloads]
            with patch.object(controls, "urlopen", side_effect=responses), patch.object(controls.time, "sleep"):
                return controls.fetch_batch(["000001", "000002"], Path(self.tmp.name) / "raw")
        records, available = fetch([page([source_row()], 2, 2), page([source_row("000002")], 2, 2)])
        self.assertEqual(available, {"000001", "000002"})
        self.assertEqual(len(records), 6)
        for payloads in ([page([source_row()], 1, 2)],
                         [page([source_row()], 2, 2), page([source_row()], 2, 2)],
                         [page([source_row()], 2, 2), page([source_row("000002")], 2, 3)]):
            with self.subTest(payloads=payloads), self.assertRaises(ValueError):
                fetch(payloads)

    def test_missing_source_preserves_entire_batch_and_outer_transaction(self):
        records, found, *_ = controls.normalize_page(page([source_row("000002")]), {"000002"})
        save_batch(self.conn, ["000002"], records, found)
        before = list(self.conn.execute("SELECT * FROM stock_control_owners"))
        with self.assertRaises(ValueError):
            save_batch(self.conn, ["000001", "000002"], [], set())
        self.assertEqual(list(self.conn.execute("SELECT * FROM stock_control_owners")), before)
        self.assertIsNone(self.conn.execute("SELECT * FROM stock_control_profiles WHERE code='000001'").fetchone())
        with self.assertRaises(RuntimeError):
            with transaction(self.conn):
                save_batch(self.conn, ["000001"], [], {"000001"})
                raise RuntimeError("outer rollback")
        self.assertIsNone(self.conn.execute("SELECT * FROM stock_control_profiles WHERE code='000001'").fetchone())

    def test_refresh_only_requests_missing_or_24_hour_stale_profiles(self):
        save_batch(self.conn, ["000001"], [], {"000001"})
        with patch.object(controls, "fetch_batch", return_value=([], {"000002"})) as fetch:
            self.assertEqual(controls.refresh(self.path), 1)
            self.assertEqual(fetch.call_args.args[0], ["000002"])
        with patch.object(controls, "fetch_batch") as fetch:
            self.assertEqual(controls.refresh(self.path), 0)
            fetch.assert_not_called()
        with transaction(self.conn):
            self.conn.execute("UPDATE stock_control_profiles SET fetched_at=? WHERE code='000001'",
                              ((datetime.now(TZ) - timedelta(hours=25)).isoformat(),))
        with patch.object(controls, "fetch_batch", return_value=([], {"000001"})) as fetch:
            controls.refresh(self.path)
            self.assertEqual(fetch.call_args.args[0], ["000001"])

    def test_disallowed_kind_is_rejected_and_not_displayed(self):
        records, found, *_ = controls.normalize_page(page([source_row()]), {"000001"})
        records[0]["kind"] = "parent_owner"
        with self.assertRaises(ValueError):
            save_batch(self.conn, ["000001"], records, found)
        self.assertEqual(stock_view(self.conn, "000001")["rows"], [])

    def test_read_does_not_initialize_or_modify_database(self):
        before = self.conn.total_changes
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        self.assertEqual(stock_view(self.conn, "000001")["status"], "empty")
        with closing(connect(self.path)) as conn:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], version)
        self.assertEqual(self.conn.total_changes, before)
