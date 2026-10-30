"""Current disclosed-name relationships and today-only limit-up projections."""
from datetime import datetime, timedelta
import re
from lianban.core.clock import TZ
from lianban.core.stock import is_st_name
from lianban.core.shareholders import SOURCE, SCOPE_NOTE, exclusion_reason
from lianban.storage.settings import get_settings
from lianban.ingestion import live_pool


def today_limit_ups(conn, *, include_live=True, now=None):
    current = (now or datetime.now(TZ)).astimezone(TZ)
    today = current.date().isoformat()
    confirmed = conn.execute("SELECT fetched_at FROM days WHERE date=? AND status='ok'", (today,)).fetchone()
    pool = live_pool.snapshot(conn, today) if include_live and not confirmed else None
    if confirmed:
        limit_codes = {r["code"] for r in conn.execute("SELECT code,name FROM events WHERE date=?", (today,)) if not is_st_name(r["name"])}
    else:
        limit_codes = {r["code"] for r in pool["records"] if not is_st_name(r["name"])} if pool else set()
    return current, confirmed, pool, limit_codes


def today_alerts(conn, *, include_live=True, now=None):
    current, _, _, codes = today_limit_ups(conn, include_live=include_live, now=now)
    holders, alerts = {}, {}
    if len(codes) > 1:
        placeholders = ",".join("?" for _ in codes)
        for row in conn.execute(f"SELECT code,holder_key,holder_name,holder_type FROM stock_shareholders WHERE code IN ({placeholders})", sorted(codes)):
            if exclusion_reason(row["holder_name"]):
                continue
            holders.setdefault(row["holder_key"], {}).setdefault(row["code"], set()).add(row["holder_type"])
        for stocks in holders.values():
            if len(stocks) < 2:
                continue
            for code in stocks:
                for peer, types in stocks.items():
                    if peer != code:
                        alerts.setdefault(code, set()).update(types)
    # Return all qualifying categories once; each browser applies its own blocks.
    return {"today": current.date().isoformat(),
            "rows": [{"code": code, "types": sorted(types)} for code, types in sorted(alerts.items())]}


def stock_view(conn, code, *, include_live=True, now=None):
    if not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    current, confirmed, pool, limit_codes = today_limit_ups(conn, include_live=include_live, now=now)
    today = current.date().isoformat()
    profiles = [dict(r) for r in conn.execute("SELECT scope,report_date,fetched_at FROM shareholder_profiles WHERE code=? ORDER BY scope DESC", (code,))]
    settings = get_settings(conn)
    peers = {}
    matches = conn.execute("SELECT DISTINCT p.code,s.name,p.holder_key,p.holder_name,p.holder_type,p.scope,p.report_date "
        "FROM stock_shareholders p JOIN stocks s ON s.code=p.code "
        "WHERE p.code<>? AND p.holder_key IN (SELECT holder_key FROM stock_shareholders WHERE code=?)", (code, code))
    for row in matches:
        if is_st_name(row["name"]):
            continue
        peer = peers.setdefault(row["code"], {"code": row["code"], "name": row["name"], "holders": {},
                    "today_together": code in limit_codes and row["code"] in limit_codes})
        holder = peer["holders"].setdefault(row["holder_key"], {"name": row["holder_name"], "type": row["holder_type"], "reports": []})
        reason = exclusion_reason(row["holder_name"])
        if reason:
            holder["exclusion_reason"] = reason
        holder["reports"].append({"scope": row["scope"], "date": row["report_date"]})
    rows = []
    for peer in peers.values():
        peer["holders"] = sorted(peer["holders"].values(), key=lambda h: h["name"])
        peer["shared_count"] = len(peer["holders"])
        rows.append(peer)
    rows.sort(key=lambda p: (not p["today_together"], -p["shared_count"], p["code"]))
    conn.create_function("is_st_name", 1, is_st_name, deterministic=True)
    return {"code": code, "profiles": profiles, "rows": rows, "total": len(rows),
            "status": settings.get("shareholder_status", "empty"), "source": SOURCE, "scope_note": SCOPE_NOTE,
            "today": today, "today_status": "confirmed" if confirmed else "provisional" if pool else "unavailable",
            "today_fetched_at": confirmed[0] if confirmed else pool["fetched_at"] if pool else None,
            "today_stale": bool(pool and current - datetime.fromisoformat(pool["fetched_at"]) > timedelta(minutes=3)),
            "coverage": conn.execute("SELECT COUNT(DISTINCT p.code) FROM stock_shareholders p JOIN stocks s ON s.code=p.code WHERE NOT is_st_name(s.name)").fetchone()[0],
            "requested": conn.execute("SELECT COUNT(*) FROM stocks WHERE NOT is_st_name(name)").fetchone()[0]}
