"""Validate personal fact records; create a separate database, never alter the live one."""
import argparse
from contextlib import closing
import csv
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
import re

import database as db


def read_facts(path):
    path = Path(path)
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("文件超过 8 MiB，请按批次整理")
    records, seen = [], set()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = set(reader.fieldnames or [])
        if (len(columns) != len(reader.fieldnames or []) or
                not {"date", "code", "name"} <= columns or columns - {"date", "code", "name", "boards"}):
            raise ValueError("表头须为 date,code,name，可另加 boards；不接受其他内容字段")
        for line, row in enumerate(reader, 2):
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f"第 {line} 行列数与表头不一致")
            day, code, name = (row[key].strip() for key in ("date", "code", "name"))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or date.fromisoformat(day) > datetime.now(db.TZ).date():
                raise ValueError(f"第 {line} 行日期无效或尚未发生")
            if not re.fullmatch(r"[0-9]{6}", code) or not name or len(name) > 40:
                raise ValueError(f"第 {line} 行代码须为六位数字，名称须为 1 至 40 字")
            if (day, code) in seen:
                raise ValueError(f"第 {line} 行日期和股票代码重复")
            seen.add((day, code))
            boards = row.get("boards", "").strip()
            if boards and (not re.fullmatch(r"[0-9]{1,3}", boards) or not 1 <= int(boards) <= 100):
                raise ValueError(f"第 {line} 行连板数须为 1 至 100，未核实时请留空")
            records.append({"date": day, "code": code, "name": name,
                            "boards": int(boards) if boards else None})
            if len(records) > 100000:
                raise ValueError("最多接收 100000 行，请按批次整理")
    if not records:
        raise ValueError("模板尚未填写记录")
    return records


def create_database(source, destination, source_note):
    records = read_facts(source)
    if not isinstance(source_note, str) or not 1 <= len(source_note.strip()) <= 500:
        raise ValueError("请如实填写 1 至 500 字的记录来源说明，保留看盘工具或原始来源信息")
    if any(row["boards"] is None for row in records):
        raise ValueError("连板数尚未核实：可以先校验前三列，但生成查询库前须补齐；不会默认记为首板")
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Never copy the existing vendor archive and relabel it as personal observations.
    with destination.open("xb"):
        pass
    days = sorted({row["date"] for row in records})
    with closing(db.connect(destination)) as conn:
        db.set_settings(conn, range_start=days[0], range_end=days[-1],
                        source="个人手工复盘记录", coverage_status="partial",
                        scope_note="仅包含人工录入的股票与日期，未收录不代表未涨停或全市场无记录。",
                        method_note="连板数采用录入者核实的值；未自动按缺失日期推算。",
                        manual_import_source_note=source_note.strip(),
                        manual_import_sha256=hashlib.sha256(Path(source).read_bytes()).hexdigest())
        for day in days:
            db.save_day(conn, day, [row for row in records if row["date"] == day],
                        "个人手工复盘记录", note="人工记录，覆盖范围可能不完整")
        if conn.execute("PRAGMA integrity_check").fetchall()[0][0] != "ok":
            raise RuntimeError("新查询库完整性校验失败，原始文件与原库未改动")
    return destination


def main():
    parser = argparse.ArgumentParser(description="校验手工涨停事实 CSV，或生成独立查询库")
    parser.add_argument("csv", type=Path)
    parser.add_argument("--output", type=Path, help="全新数据库路径；不覆盖任何已有文件")
    parser.add_argument("--source-note", help="生成查询库时必填，说明实际看盘工具、记录方式及授权情况")
    args = parser.parse_args()
    try:
        rows = read_facts(args.csv)
        result = {"records": len(rows), "dates": sorted({row["date"] for row in rows}),
                  "unverified_boards": sum(row["boards"] is None for row in rows)}
        if args.output:
            result["created_database"] = str(create_database(args.csv, args.output, args.source_note))
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
