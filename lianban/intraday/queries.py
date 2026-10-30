"""Read-side composition for minute views; no upstream requests."""
from contextlib import closing
from datetime import datetime
import json
import re
import sqlite3
import lianban.storage.api as db
from lianban.core.clock import TZ
from lianban.ingestion import live_pool
from .rules import validate_day, is_mainboard
from .store import store_path, _cached, catalog, auction_view

SCOPE = '当前沪深 A 股主板目录（已剔除 ST、*ST，不含创业板、科创板、北交所及 B 股）；按所选日期查看，未缓存个股选中后按需采集。'

def trading_dates(conn, *, include_live=False):
    """Reuse the project's verified calendar without fetching any minute data."""
    known = set(db.get_settings(conn).get("calendar_dates") or [])
    known.update(row[0] for row in conn.execute("SELECT date FROM days WHERE status='ok'"))
    if include_live:
        known.update(live_pool.metadata(conn)["dates"])
    today = datetime.now(TZ).date().isoformat()
    return sorted((day for day in known if isinstance(day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) and day <= today), reverse=True)


def overview(archive_path, day=None, *, include_live=False):
    if day:
        validate_day(day)
    universe = catalog(archive_path)
    with closing(db.connect(archive_path)) as conn:
        dates = trading_dates(conn, include_live=include_live)
        if day and day not in dates:
            raise ValueError("该日期不在项目已知交易日历中，请选择交易日")
        selected = day or (dates[0] if dates else None)
        events = {r["code"]: dict(r) for r in conn.execute("SELECT date,code,name,boards,close,pct_change,first_time,last_time,market,industry FROM events WHERE date=?", (selected,))}
        snapshot = live_pool.snapshot(conn, selected) if include_live else None
        if snapshot:
            events = {r["code"]: dict(r) for r in snapshot["records"]}
        if universe and selected:
            rows = [{"date": selected, "boards": 0, "industry": None, **{k: r[k] for k in ("code", "name", "market")}, **events.get(r["code"], {})} for r in universe]
        else:
            rows = [r for r in events.values() if is_mainboard(r["code"])]
        rows = [r for r in rows if not db.is_st_name(r["name"])]
        for start in range(0, len(rows), 250):
            db.enrich_stock_profiles(conn, rows[start:start + 250])
        pool = conn.execute("SELECT status,source FROM days WHERE date=?", (selected,)).fetchone()
    sessions, errors = _cached(archive_path, day=selected) if selected else ({}, {})
    for row in rows:
        cached = sessions.get((selected, row["code"]))
        row["initials"] = db.stock_initials(row["name"])
        row.update(status=cached["status"] if cached else "missing", point_count=cached["point_count"] if cached else 0,
                   source=cached["source"] if cached else None, error=errors.get((selected, row["code"]), ""))
    return {"date": selected, "dates": dates, "rows": rows, "total": len(rows),
            "ready": sum(r["status"] == "ok" for r in rows), "partial": sum(r["status"] == "partial" for r in rows),
            "missing": sum(r["status"] == "missing" for r in rows), "scope_note": SCOPE if universe else "主板目录尚未同步，当前仅展示本地已收录的非 ST 主板个股。",
            "provisional": bool(snapshot),
            "catalog_complete": bool(universe), "catalog_fetched_at": universe[0]["fetched_at"] if universe else None,
            "pool_status": "provisional" if snapshot else pool["status"] if pool else "missing", "pool_source": snapshot["source"] if snapshot else pool["source"] if pool else None}


def stock_view(archive_path, day, code, *, include_live=False):
    validate_day(day)
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    member = next((r for r in catalog(archive_path) if r["code"] == code), None)
    with closing(db.connect(archive_path)) as conn:
        if day not in trading_dates(conn, include_live=include_live):
            raise ValueError("该日期不在项目已知交易日历中，请选择交易日")
        row = conn.execute("SELECT date,code,name,boards,close,pct_change,first_time,last_time,industry FROM events WHERE date=? AND code=?", (day, code)).fetchone()
        snapshot = live_pool.snapshot(conn, day) if include_live else None
        if snapshot:
            row = next((dict(r) for r in snapshot["records"] if r["code"] == code), None)
        if row is None:
            if member:
                row = {"date": day, "boards": 0, "industry": None, **{k: member[k] for k in ("code", "name", "market")}}
        if row is not None:
            row = dict(row)
            if db.is_st_name(row["name"]):
                raise ValueError("分时数据已剔除 ST、*ST 股票")
            db.enrich_stock_profiles(conn, [row])
            row["initials"] = db.stock_initials(row["name"])
            row["blacklisted"] = conn.execute("SELECT 1 FROM stock_blacklist WHERE code=?", (code,)).fetchone() is not None
    if row is None:
        raise ValueError("该股票不在沪深主板目录或本地分时档案中")
    sessions, errors = _cached(archive_path, day=day, code=code, detail=True)
    cached = sessions.get((day, code))
    result = {"date": day, "stock": dict(row), "status": "missing", "points": [], "note": errors.get((day, code), "该股票当日分时尚未采集")}
    if cached:
        result.update(status=cached["status"], points=json.loads(cached["points_json"]), note=cached["note"],
                      previous_close=cached["previous_close"], source=cached["source"], fetched_at=cached["fetched_at"])
    result["reference_basis"] = "当日收盘价和涨幅推算"
    if cached:
        path = store_path(archive_path)
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
            attempt = conn.execute("SELECT checked_at FROM attempts WHERE date=? AND code=?", (day, code)).fetchone()
            result["refresh_checked_at"] = max(result["fetched_at"], attempt[0]) if attempt else result["fetched_at"]
            if conn.execute("SELECT 1 FROM sqlite_master WHERE name='session_context'").fetchone():
                context = conn.execute("SELECT reference_basis FROM session_context WHERE date=? AND code=?", (day, code)).fetchone()
                if context:
                    result["reference_basis"] = context[0]
    result["auction"] = auction_view(archive_path, day, code)
    result["needs_collection"] = not result["points"] or result["auction"]["status"] == "unchecked"
    result["refresh_error"] = errors.get((day, code))
    result["needs_refresh"] = include_live and live_pool.minute_refresh_due(day, result.get("refresh_checked_at"))
    result["provisional"] = bool(snapshot)
    if include_live and day == datetime.now(TZ).date().isoformat() and live_pool.polling_time() and result["points"]:
        result["note"] = f"盘中分钟数据，当前已缓存 {len(result['points'])} 个交易分钟；尚未收盘。"
    return result
