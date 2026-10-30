"""Timeline queries and explicit source-clock supplementation."""
from contextlib import closing
import json
import math
import sqlite3
import lianban.storage.api as db
from lianban.core.clock import now_iso
from lianban.ingestion import live_pool
from . import api as intraday
from .timeline_rules import SEAL_KINDS, clock_seconds, regular_time, cents, stock_events, associate, interaction_groups

def cached_seal_times(archive_path, day):
    path = intraday.store_path(archive_path)
    if not path.exists():
        return None
    with closing(sqlite3.connect(path)) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='seal_times'").fetchone():
            return None
        row = conn.execute("SELECT stocks_json,source FROM seal_times WHERE date=?", (day,)).fetchone()
    return {"stocks": json.loads(row[0]), "source": row[1]} if row else None


def collect_seal_times(archive_path, day, *, force=False):
    """Cache independently validated source clocks without replacing closing-pool facts."""
    intraday.validate_day(day)
    with closing(db.connect(archive_path)) as conn:
        if not conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (day,)).fetchone():
            raise ValueError("该日尚无已确认的涨停池")
    cached = cached_seal_times(archive_path, day)
    if cached and not force:
        return {"date": day, "count": len(cached["stocks"]), "cached": True}
    from lianban.adapters.providers import pools as provider
    result = provider._historical_day(day, provider.RAW_DIR)
    if result.status != "ok" or not result.records:
        raise ValueError("该日来源暂未提供可核验的秒级封板时间")
    stocks = {row["code"]: {key: row.get(key) for key in ("close", "first_time", "last_time")} for row in result.records}
    with closing(intraday.initialize(intraday.store_path(archive_path))) as conn, conn:
        conn.execute("INSERT INTO seal_times VALUES (?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET stocks_json=excluded.stocks_json,source=excluded.source,fetched_at=excluded.fetched_at,raw_path=excluded.raw_path",
                     (day, json.dumps(stocks), result.source, now_iso(), result.raw_path))
    return {"date": day, "count": len(stocks), "cached": False}


def enrich_seal_times(archive_path, day, pool):
    cached = cached_seal_times(archive_path, day)
    for stock in pool:
        supplement = cached["stocks"].get(stock["code"]) if cached else None
        if not supplement or not stock.get("close") or not supplement.get("close") or cents(stock["close"]) != cents(supplement["close"]):
            continue
        for field in ("first_time", "last_time"):
            if not stock.get(field) and clock_seconds(supplement.get(field)) is not None:
                stock[field] = supplement[field]
                stock["clock_source"] = cached["source"]
    return {"cached": cached is not None, "missing": sum(clock_seconds(stock.get("first_time")) is None for stock in pool)}


def timeline(archive_path, day, window=2, multiple=3, *, exclude_gem=True, include_live=False):
    intraday.validate_day(day)
    if not isinstance(window, int) or not 0 <= window <= 10:
        raise ValueError("关联窗口应为0至10分钟，0表示同一分钟")
    if not math.isfinite(float(multiple)) or not 2 <= float(multiple) <= 10:
        raise ValueError("放量倍数应为2至10倍")
    if not isinstance(exclude_gem, bool):
        raise ValueError("创业板屏蔽选项无效")
    multiple = float(multiple)
    with closing(db.connect(archive_path)) as conn:
        if day not in intraday.trading_dates(conn, include_live=include_live):
            raise ValueError("该日期不在项目已知交易日历中")
        snapshot = live_pool.snapshot(conn, day) if include_live else None
        records = snapshot["records"] if snapshot else conn.execute("SELECT date,code,name,boards,close,first_time,last_time,open_times FROM events WHERE date=? ORDER BY boards DESC,code", (day,))
        pool = [dict(r) for r in records
                if (intraday.is_mainboard(r["code"]) or not exclude_gem and db.market_for(r["code"]) == "创业板")
                and not db.is_st_name(r["name"])]
        db.enrich_stock_profiles(conn, pool)
    time_coverage = {"cached": False, "missing": sum(not r.get("first_time") for r in pool)} if snapshot else enrich_seal_times(archive_path, day, pool)
    if snapshot:
        for stock in pool:
            stock["clock_source"] = "盘中暂定池"
    sessions, errors = intraday._cached(archive_path, day=day, detail=True)
    events, jobs, analyzed, partial = [], [], 0, 0
    for stock in pool:
        cached = sessions.get((day, stock["code"]))
        points = json.loads(cached["points_json"]) if cached else []
        auction = intraday.auction_view(archive_path, day, stock["code"]) if points else {}
        if points:
            analyzed += 1
            partial += cached["status"] != "ok"
        if not points or cached["status"] != "ok" or auction.get("status") == "unchecked":
            jobs.append({"code": stock["code"], "name": stock["name"], "force": bool(points and cached["status"] != "ok")})
        events.extend(stock_events(stock, points, auction, multiple))
    events = associate(events, window)
    return {"date": day, "window": window, "multiple": multiple, "pool": pool, "provisional": bool(snapshot),
            "scope": {"start_time": "09:30", "exclude_st": True, "exclude_gem": exclude_gem},
            "coverage": {"total": len(pool), "analyzed": analyzed, "partial": partial, "missing": len(pool) - analyzed},
            "jobs": jobs, "events": events, "interactions": interaction_groups(events, window), "time_coverage": time_coverage, "generated_at": now_iso()}
