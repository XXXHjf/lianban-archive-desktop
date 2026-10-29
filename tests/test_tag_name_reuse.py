"""Rename results survive upgrades/refreshes without occupying old names."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
import tag_management as tags


class DetachedTagNameTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.initialize(":memory:")
        db.save_day(self.conn, "2026-10-28", [
            {"code": "603006", "name": "联明股份", "boards": 1},
            {"code": "000002", "name": "测试乙", "boards": 2},
            {"code": "000003", "name": "测试丙", "boards": 1}], "synthetic")
        db.set_settings(self.conn, default_tag_mode="concept_intersection")

    def tearDown(self):
        self.conn.close()

    def defaults(self, code, labels):
        db.save_default_tags(self.conn, [{"code": code, "tags": labels, "ths_tags": labels,
                                         "cls_tags": labels, "fetched_at": db.now_iso()}], "synthetic")

    def revision(self):
        return tags.catalog(self.conn)["revision"]

    def snapshot(self):
        return {table: [tuple(row) for row in self.conn.execute("SELECT * FROM " + table)] for table in (
            "stock_tag_overrides", "stock_default_tags", "stock_tag_exclusions", "tag_aliases", "tag_nodes",
            "deleted_tags", "settings", "events", "stock_notes", "stock_blacklist")}

    def legacy(self):
        self.defaults("603006", ["汽车零部件", "汽车"])
        self.defaults("000002", ["汽车零部件", "机器人零部件"])
        db.save_stock_tags(self.conn, "603006", ["汽车零部件", "自定义", "汽车"], 0)
        db.save_stock_tags(self.conn, "000002", ["机器人零部件"], 0)
        db.save_stock_note(self.conn, "603006", "保留备注", 0)
        db.save_blacklist(self.conn, "603006", "add")
        with self.conn:
            self.conn.executemany("INSERT INTO tag_aliases VALUES (?,?)", [
                ("汽车零部件", "机器人零部件"), ("零部件", "机器人零部件"), ("机器人零部件", "机器人零部件")])
            self.conn.executemany("INSERT INTO tag_nodes VALUES (?,?,?)", [
                ("机器人", "机器人", None), ("汽车零部件", "汽车零部件", "机器人"),
                ("电机", "电机", "汽车零部件")])
            self.conn.execute("DELETE FROM settings WHERE key='tag_name_storage'")

    def test_upgrade_preserves_memberships_tree_and_evidence_then_releases_old_name(self):
        self.legacy()
        before = self.snapshot()
        previous = {code: db.get_stock_tags(self.conn, code)["tags"] for code in ("603006", "000002", "000003")}
        tree = tags.hierarchy(self.conn)
        tags.migrate_detached_names(self.conn)
        for code, labels in previous.items():
            self.assertEqual(db.get_stock_tags(self.conn, code)["tags"], labels)
        self.assertEqual(tags.hierarchy(self.conn), tree)
        for table in ("stock_default_tags", "events", "stock_notes", "stock_blacklist"):
            self.assertEqual(self.snapshot()[table], before[table], table)
        self.assertTrue(all(key == name.casefold() for key, name in db.get_tag_aliases(self.conn).items()))
        once = self.snapshot()
        tags.migrate_detached_names(self.conn)
        self.assertEqual(self.snapshot(), once, "migration runs once")
        # Reproduces entering 汽车零部件 in the stock editor after the old rename.
        current = db.get_stock_tags(self.conn, "603006")
        saved = db.save_stock_tags(self.conn, "603006", current["tags"] + ["汽车零部件"], current["revision"],
                                   alias_revision=current["tag_alias_revision"])
        self.assertIn("汽车零部件", saved["tags"])
        self.assertIn("机器人零部件", saved["tags"])
        tags.save_node(self.conn, "汽车零部件", "", self.revision(), "parent")
        self.assertIn({"name": "汽车零部件", "parent": ""}, tags.hierarchy(self.conn))
        tags.rename(self.conn, "机器人零部件", "机器人配件", self.revision())
        self.assertIn("汽车零部件", db.get_stock_tags(self.conn, "603006")["tags"])
        self.assertEqual(next(n for n in tags.hierarchy(self.conn) if n["name"] == "电机")["parent"], "机器人配件")

    def test_renamed_defaults_survive_refresh_while_old_name_on_other_stock_is_independent(self):
        self.defaults("603006", ["汽车零部件", "汽车"])
        evidence = self.snapshot()["stock_default_tags"]
        tags.rename(self.conn, "汽车零部件", "机器人零部件", self.revision())
        self.assertEqual(self.snapshot()["stock_default_tags"], evidence)
        self.defaults("603006", ["汽车零部件", "汽车", "新来源概念"])
        self.assertCountEqual(db.get_stock_tags(self.conn, "603006")["tags"], ["机器人零部件", "汽车", "新来源概念"])
        db.save_stock_tags(self.conn, "000003", ["汽车零部件"], 0)
        tags.rename(self.conn, "汽车零部件", "车身配件", self.revision())
        self.assertIn("机器人零部件", db.get_stock_tags(self.conn, "603006")["tags"])
        self.assertEqual(db.get_stock_tags(self.conn, "000003")["tags"], ["车身配件"])
        self.assertEqual(tags.members(self.conn, "机器人零部件")["count"], 1)

    def test_legacy_deleted_target_remains_hidden_and_does_not_reserve_alias(self):
        self.legacy()
        with self.conn:
            self.conn.execute("INSERT INTO deleted_tags VALUES (?,?,?)", ("机器人零部件", "机器人零部件", db.now_iso()))
        visible = db.get_stock_tags(self.conn, "603006")["tags"]
        tags.migrate_detached_names(self.conn)
        self.assertEqual(db.get_stock_tags(self.conn, "603006")["tags"], visible)
        tags.save_node(self.conn, "汽车零部件", "", self.revision())
        tags.add_stock(self.conn, "汽车零部件", "000003", self.revision())
        self.assertEqual(db.get_stock_tags(self.conn, "000003")["tags"], ["汽车零部件"])

    def test_upgrade_and_rename_failures_roll_back_every_membership_and_alias(self):
        self.legacy()
        db.set_settings(self.conn, tag_alias_revision=0)
        with self.conn:
            self.conn.execute("CREATE TRIGGER fail_names BEFORE UPDATE ON settings WHEN OLD.key='tag_alias_revision' BEGIN SELECT RAISE(ABORT,'failure'); END")
        before = self.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            tags.migrate_detached_names(self.conn)
        self.assertEqual(self.snapshot(), before)
        self.conn.execute("DROP TRIGGER fail_names")
        tags.migrate_detached_names(self.conn)
        with self.conn:
            self.conn.execute("CREATE TRIGGER fail_rename BEFORE UPDATE ON settings WHEN OLD.key='tag_alias_revision' BEGIN SELECT RAISE(ABORT,'failure'); END")
        before = self.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            tags.rename(self.conn, "机器人零部件", "新名字", self.revision())
        self.assertEqual(self.snapshot(), before)

    def test_industry_fallback_rename_does_not_change_raw_industry(self):
        db.set_settings(self.conn, default_tag_mode="industry")
        db.save_industries(self.conn, [{"code": "603006", "industry": "汽车零部件", "industry_level2": "",
                          "industry_level3": "", "industry_code": "1", "effective_from": "2020-01-01",
                          "source_updated_at": "2026-10-28"}], "synthetic", db.now_iso(), [])
        tags.rename(self.conn, "汽车零部件", "机器人零部件", self.revision())
        self.assertEqual(db.get_stock_tags(self.conn, "603006")["tags"], ["机器人零部件"])
        self.assertEqual(self.conn.execute("SELECT industry FROM stock_industries").fetchone()[0], "汽车零部件")
        current = db.get_stock_tags(self.conn, "603006")
        self.assertEqual(db.save_stock_tags(self.conn, "603006", ["汽车零部件"], current["revision"])["tags"], ["汽车零部件"])


if __name__ == "__main__":
    unittest.main()
