"""Compatibility entrypoint for explicit minute catalog/stock collection."""
from lianban.config import DEFAULT_DB
from pathlib import Path
import json
from lianban.intraday.collection import *

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="同步完整沪深主板目录，或采集指定个股分时及 09:25 竞价撮合记录")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--catalog", action="store_true")
    parser.add_argument("--date")
    parser.add_argument("--codes", nargs="+")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.catalog:
        print(json.dumps(sync_catalog(args.db), ensure_ascii=False), flush=True)
    if args.date and args.codes:
        for code in args.codes:
            detail = collect_requested(args.db, args.date, code, force=args.force)
            print(json.dumps({"code": code, "status": detail["status"], "points": len(detail["points"]), "auction": detail["auction"]["status"]}, ensure_ascii=False), flush=True)
