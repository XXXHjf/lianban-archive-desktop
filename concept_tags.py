"""Compatibility entrypoint for company profile operations."""
from lianban.profiles.concepts import *

if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="补充同花顺和财联社共有概念，保留全部自定义标签")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--force", action="store_true", help="重新抓取七天内的有效快照")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    with closing(initialize(args.db)):
        pass
    report = refresh(args.db, force=args.force, workers=args.workers,
                     progress=lambda done, total: print(f"概念标签进度 {done}/{total}", flush=True))
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, ensure_ascii=False) if report else "另一轮概念更新正在运行。", flush=True)
