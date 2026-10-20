"""Consistent SQLite snapshots. Never overwrites or deletes an existing file."""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from uuid import uuid4


def snapshot(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation also prevents a typo from replacing the live DB.
    with destination.open("xb"):
        pass
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30)) as src:
        with closing(sqlite3.connect(destination)) as dst:
            src.backup(dst, pages=256, sleep=0.1)
            if dst.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("数据库备份完整性检查失败，文件保留供排查。")
    return destination


def main():
    parser = argparse.ArgumentParser(description="备份数据库和股票标签，不自动删除旧文件")
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = args.output_dir / f"archive-{stamp}-{uuid4().hex[:8]}.sqlite3"
    print(snapshot(args.db, target))


if __name__ == "__main__":
    main()
