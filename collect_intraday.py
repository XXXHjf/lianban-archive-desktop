"""Command-line entrypoint for batch minute collection."""
import argparse
from pathlib import Path
from lianban.config import DEFAULT_DB
from lianban.intraday.batch import collect, fetch_stock

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="采集指定日期涨停池的近期分时数据，不改动涨停事实库")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--dates", nargs="+", required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    report = collect(args.db, args.dates, force=args.force)
    raise SystemExit(1 if any(day["missing"] or day["partial"] for day in report["days"]) else 0)
