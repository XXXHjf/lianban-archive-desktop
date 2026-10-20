from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

import import_manual


class ManualImportTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="lianban-manual-"))
        self.csv = self.root / "facts.csv"
        self.out = self.root / "personal.sqlite3"

    def write(self, content):
        self.csv.write_text(content, encoding="utf-8-sig")

    def test_three_fact_columns_validate_without_inventing_board_counts(self):
        self.write("date,code,name\n2026-01-05,000001,测试股票\n")
        rows = import_manual.read_facts(self.csv)
        self.assertEqual(rows[0]["code"], "000001")
        self.assertIsNone(rows[0]["boards"])
        with self.assertRaises(ValueError):
            import_manual.create_database(self.csv, self.out, "synthetic fixture")
        self.assertFalse(self.out.exists())

    def test_separate_database_preserves_source_and_does_not_overwrite(self):
        self.write("date,code,name,boards\n2026-01-05,000001,测试股票,2\n")
        original = self.csv.read_bytes()
        import_manual.create_database(self.csv, self.out, "synthetic fixture")
        with closing(sqlite3.connect(self.out)) as conn:
            self.assertEqual(conn.execute("SELECT code,boards,limit_up_reason FROM events").fetchone(),
                             ("000001", 2, None))
        self.assertEqual(self.csv.read_bytes(), original)
        saved = self.out.read_bytes()
        with self.assertRaises(FileExistsError):
            import_manual.create_database(self.csv, self.out, "synthetic fixture")
        self.assertEqual(self.out.read_bytes(), saved)

    def test_duplicates_extra_text_and_invalid_facts_rejected(self):
        for content in (
            "date,code,name,reason\n2026-01-05,000001,测试股票,text\n",
            "date,code,name\n2026-01-05,000001,测试股票\n2026-01-05,000001,测试股票\n",
            "date,code,name,boards\n2026-01-05,000001,测试股票,0\n",
            "date,code,name\n2026-02-30,000001,测试股票\n",
            "date,code,name\n2026-01-05,1,测试股票\n",
            "date,code,name,name\n2026-01-05,000001,测试股票,其他\n",
        ):
            with self.subTest(content=content), self.assertRaises(ValueError):
                self.write(content)
                import_manual.read_facts(self.csv)


if __name__ == "__main__":
    unittest.main()
