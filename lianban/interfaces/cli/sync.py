"""Archive a requested date range, gently, with validation and resume support."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
import json
import time
from contextlib import closing

from lianban.profiles import industry
from lianban.profiles import concepts as concept_tags
from lianban.profiles import registration
from lianban.core.clock import target_day

from lianban.config import DEFAULT_DB
from lianban.storage import initialize, connect
from lianban.storage.settings import REQUEST_START, REQUEST_END, get_settings, set_settings
from lianban.archive.service import save_day
from lianban.adapters.providers.pools import (SOURCE, SUMMARY_SOURCE, POOL_URL, CALENDAR_URL, CALENDAR_SOURCE, SCOPE_NOTE, METHOD_NOTE,
                      TZ, ProviderError, fetch_day, trading_dates, valid_day)


from lianban.ingestion.backfill import run_backfill

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default=(date.fromisoformat(REQUEST_START) - timedelta(days=31)).isoformat(),
                        help="Include one month of warmup history before the archive range")
    parser.add_argument("--end", default=target_day(),
                        help="上海时间 15:30 后包含当天，此前截至昨天；避免归档尚未发布的当天来源池")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--interval", type=float, default=0.8)
    parser.add_argument("--refresh", action="store_true", help="Explicitly re-fetch already validated days")
    args = parser.parse_args(argv)
    valid_day(args.start)
    valid_day(args.end)
    if args.start > args.end or args.interval < 0.3:
        parser.error("开始日期不得晚于结束日期；请求间隔不得低于 0.3 秒")
    return run_backfill(args)
