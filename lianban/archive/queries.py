from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from collections import Counter
from lianban.storage.settings import get_settings
from lianban.storage.trading_calendar import context as trading_calendar_context
from lianban.core.stock import market_for, is_st_name
from lianban.readside.stock_profiles import enrich_stock_profiles
from lianban.research.presentation import stock_initials
from lianban.archive.relationship_queries import stock_relationships, stock_pair_comparison
from lianban.archive.cycles import observed_cycles

def suspended_leaders(conn, day):
    settings = get_settings(conn)
    calendar = sorted(set(settings.get("calendar_dates", [])) | {r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok'")})
    result = []
    for suspension in conn.execute("SELECT * FROM suspension_records WHERE date=? AND full_day=1", (day,)):
        start_day = suspension["start"][:10]
        previous = next((d for d in reversed(calendar) if d < start_day), None)
        if not previous:
            continue
        event = conn.execute("SELECT * FROM events WHERE code=? AND date=? AND boards>=2", (suspension["code"], previous)).fetchone()
        # Never carry an old peak past a later traded day or into the actual pool.
        intervening = conn.execute("SELECT 1 FROM events WHERE code=? AND date>? AND date<=? LIMIT 1",
                                   (suspension["code"], previous, day)).fetchone()
        previous_day = conn.execute("SELECT status FROM days WHERE date=?", (previous,)).fetchone()
        if not event or intervening or not previous_day or previous_day[0] != "ok":
            continue
        result.append({**dict(event), "date": day, "suspended": True, "board_date": previous,
                       "suspension_start": start_day, "resume_date": suspension["resume"],
                       "suspension_reason": suspension["reason"]})
    enrich_stock_profiles(conn, result)
    return sorted(result, key=lambda row: (-row["boards"], row["code"]))


def meta(conn, *, now=None):
    settings = get_settings(conn)
    settings.pop("site_links", None)  # Link configuration has its own public, filtered response.
    start, end = settings["range_start"], settings["range_end"]
    dates = [r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok' AND date BETWEEN ? AND ? ORDER BY date", (start, end))]
    conn.create_function("is_st_name", 1, is_st_name, deterministic=True)
    counts = conn.execute("SELECT COUNT(*) records, COUNT(DISTINCT code) stocks FROM events WHERE date BETWEEN ? AND ? AND NOT is_st_name(name)", (start, end)).fetchone()
    attempts = Counter(r["status"] for r in conn.execute("SELECT status FROM days WHERE date BETWEEN ? AND ?", (start, end)))
    last = conn.execute("SELECT MAX(fetched_at) FROM days").fetchone()[0]
    archive_updated = conn.execute("SELECT MAX(fetched_at) FROM days WHERE status='ok'").fetchone()[0]
    calendar = trading_calendar_context(conn, now=now)
    latest_limit_ups = [dict(r) for r in conn.execute(
        "SELECT code,boards FROM events WHERE date=? AND NOT is_st_name(name) ORDER BY code", (calendar["latest_trade_date"],))]
    examples = [dict(r) for r in conn.execute("SELECT e.code,(SELECT e2.name FROM events e2 WHERE e2.code=e.code AND e2.date BETWEEN ? AND ? AND NOT is_st_name(e2.name) ORDER BY e2.date DESC LIMIT 1) name,MAX(e.boards) highest,COUNT(*) observations FROM events e WHERE e.date BETWEEN ? AND ? AND NOT is_st_name(e.name) GROUP BY e.code ORDER BY highest DESC,observations DESC LIMIT 6", (start, end, start, end))]
    node_updated = conn.execute('SELECT MAX(checked_at) FROM node_checks').fetchone()[0]
    return {**settings, "trading_calendar": calendar,
            "node_updated_at": node_updated, "latest_date": dates[-1] if dates else None, "dates": dates,
            "suspension_updating": conn.execute("SELECT COUNT(*) FROM suspension_days WHERE status='updating'").fetchone()[0],
            "available_start": dates[0] if dates else None, "available_end": dates[-1] if dates else None,
            "coverage": {"days": len(dates), "stocks": counts["stocks"], "records": counts["records"],
                         "status": settings.get("coverage_status", "partial"),
                         "note": settings.get("coverage_note", settings["scope_note"]), "attempts": dict(attempts)},
            "examples": examples, "updated_at": last, "archive_updated_at": archive_updated,
            "latest_limit_ups": latest_limit_ups}


def date_view(conn, day, min_boards=1, market="all", query="", exclude_st=False, boards=None, exclude_gem=False, *, snapshot=None):
    settings = get_settings(conn)
    market = {"sh": "沪市主板", "sz": "深市主板", "gem": "创业板", "star": "科创板", "bj": "北交所"}.get(market, market)
    coverage = conn.execute("SELECT * FROM days WHERE date=?", (day,)).fetchone()
    rows = [dict(r) for r in conn.execute("SELECT * FROM events WHERE date=? ORDER BY boards DESC,code", (day,))]
    if coverage and coverage["status"] == "ok":
        snapshot = None
    if snapshot:
        coverage = {"status": "provisional", "source": snapshot["source"], "note": snapshot["note"]}
        rows = sorted((dict(r) for r in snapshot["records"]), key=lambda r: (-r["boards"], r["code"]))
    enrich_stock_profiles(conn, rows)
    rows = [r for r in rows if (market == "all" or r["market"] == market)
            and (not query or query.casefold() in (r["code"] + r["name"]).casefold())
            and not is_st_name(r["name"])
            and (not exclude_gem or market_for(r["code"]) != "创业板")]
    board_counts = Counter(r["boards"] for r in rows)
    available_total = len(rows)
    # Keep the full day's tag cohorts when the visible rows select one height.
    tag_board_counts = {}
    from lianban.research.tag_management import hierarchy
    parents = {node["name"].casefold(): node["parent"] for node in hierarchy(conn) if node["parent"]}
    def root_tag(name):
        seen = set()
        while name.casefold() in parents and name.casefold() not in seen:
            seen.add(name.casefold())
            name = parents[name.casefold()]
        return name
    for row in rows:
        for tag in dict.fromkeys([*row["tags"], *(root_tag(tag) for tag in row["tags"])]):
            counts = tag_board_counts.setdefault(tag, {})
            height = str(row["boards"])
            counts[height] = counts.get(height, 0) + 1
    if boards is not None and (isinstance(boards, bool) or not isinstance(boards, int) or not 1 <= boards <= 100):
        raise ValueError("连板数应为 1 至 100 的整数")
    rows = [r for r in rows if r["boards"] >= min_boards and (boards is None or r["boards"] == boards)]
    suspended = [r for r in suspended_leaders(conn, day) if r["boards"] >= min_boards
                 and (boards is None or r["boards"] == boards) and (market == "all" or r["market"] == market)
                 and (not query or query.casefold() in (r["code"] + r["name"]).casefold())
                 and not is_st_name(r["name"])
                 and (not exclude_gem or market_for(r["code"]) != "创业板")]
    blacklist_codes = {r[0] for r in conn.execute("SELECT code FROM stock_blacklist")}
    for row in [*rows, *suspended]:
        row["blacklisted"] = row["code"] in blacklist_codes
        row["initials"] = stock_initials(row["name"])
    suspension_day = conn.execute("SELECT * FROM suspension_days WHERE date=?", (day,)).fetchone()
    from lianban.nodes.service import decorate
    node_data = decorate(conn, day, rows) if not snapshot else {"nodes": [], "check": None}
    groups = Counter(r["boards"] for r in rows)
    note = settings["scope_note"]
    if not coverage:
        note = "该日期尚未收录。休市、数据缺失或接口不支持历史日期均可能导致无记录，不能据此判断没有涨停。"
    elif coverage["status"] == "failed":
        note = "该日期的来源数据暂未获取或未通过校验，正在自动重试。不能据此判断当天没有涨停。"
    elif coverage["status"] != "ok":
        note = coverage["note"] or "来源未返回可确认的该日数据，不能据此判断没有涨停。"
    return {"date": day, "coverage_note": note, "data_status": coverage["status"] if coverage else "missing",
            "provisional": bool(snapshot), "fetched_at": snapshot["fetched_at"] if snapshot else coverage["fetched_at"] if coverage else None,
            "source": coverage["source"] if coverage else None,
            "rows": rows, "nodes": node_data['nodes'], "node_check": node_data['check'],
            "selected_boards": boards, "available_total": available_total,
            "tag_board_counts": tag_board_counts,
            "suspended_rows": suspended,
            "suspension_status": suspension_day["status"] if suspension_day else "unknown",
            "trading_max_boards": max(groups, default=0),
            "board_counts": [{"boards": k, "count": v} for k, v in sorted(board_counts.items())],
            "stats": {"total": len(rows), "consecutive": sum(r["boards"] >= 2 for r in rows),
                                      "max_boards": max([*groups, *(r["boards"] for r in suspended)], default=0), "first_boards": groups.get(1, 0)},
            "groups": [{"boards": k, "count": v} for k, v in sorted(groups.items(), reverse=True)]}


def search_stocks(conn, query=""):
    query = query.strip()
    initials = re.sub(r"\s+", "", query).upper()
    use_initials = bool(re.fullmatch(r"[A-Z]+", initials))
    conn.create_function("stock_initials", 1, stock_initials, deterministic=True)
    conn.create_function("is_st_name", 1, is_st_name, deterministic=True)
    # Match past source-provided names too, rather than only today's name.
    pattern = "%" + query + "%"
    if use_initials:
        rows = conn.execute("SELECT s.code,s.name,s.market FROM stocks s WHERE NOT is_st_name(s.name) AND (s.code LIKE ? OR s.name LIKE ? "
                            "OR stock_initials(s.name) LIKE ? OR EXISTS(SELECT 1 FROM events e WHERE e.code=s.code "
                            "AND NOT is_st_name(e.name) AND (e.name LIKE ? OR stock_initials(e.name) LIKE ?))) "
                            "ORDER BY CASE WHEN stock_initials(s.name)=? THEN 0 ELSE 1 END,s.last_seen DESC,s.code LIMIT 40",
                            (pattern, pattern, "%" + initials + "%", pattern, "%" + initials + "%", initials))
    else:
        rows = conn.execute("SELECT s.code,s.name,s.market FROM stocks s WHERE NOT is_st_name(s.name) AND (s.code LIKE ? OR s.name LIKE ? "
                            "OR EXISTS(SELECT 1 FROM events e WHERE e.code=s.code AND NOT is_st_name(e.name) AND e.name LIKE ?)) "
                            "ORDER BY CASE WHEN s.code=? OR s.name=? THEN 0 ELSE 1 END,s.last_seen DESC,s.code LIMIT 40",
                            (pattern, pattern, pattern, query, query))
    return {"rows": [{**dict(r), "initials": stock_initials(r["name"])} for r in rows]}


def stock_view(conn, code, start, end):
    settings = get_settings(conn)
    stock = conn.execute("SELECT code,name,market FROM stocks WHERE code=?", (code,)).fetchone()
    stock = dict(stock) if stock else {"code": code, "name": "尚未收录", "market": market_for(code)}
    if is_st_name(stock["name"]):
        previous = conn.execute("SELECT name FROM events WHERE code=? AND date BETWEEN ? AND ? ORDER BY date DESC", (code, start, end))
        name = next((row["name"] for row in previous if not is_st_name(row["name"])), None)
        if name is None:
            raise ValueError("该股票在所选范围内没有非 ST 档案")
        stock["name"] = name
    stock["initials"] = stock_initials(stock["name"])
    stock["blacklisted"] = conn.execute("SELECT 1 FROM stock_blacklist WHERE code=?", (code,)).fetchone() is not None
    enrich_stock_profiles(conn, [stock])
    # Previous observations establish the first board, but later observations would leak future heights.
    source_rows = [dict(r) for r in conn.execute("SELECT * FROM events WHERE code=? AND date<=? ORDER BY date", (code, end))]
    all_rows = [row for row in source_rows if not is_st_name(row["name"])]
    available_dates = [r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok' ORDER BY date")]
    # A never-fetched trading day is a gap too. Use the provider calendar when available.
    all_dates = sorted(set(settings.get("calendar_dates", []) + available_dates))
    indices = {day: i for i, day in enumerate(all_dates)}
    attempted = {r["date"]: r["status"] for r in conn.execute("SELECT date,status FROM days")}
    # Excluded ST days are not evidence that a visible cycle has ended.
    attempted.update({row["date"]: "excluded_st" for row in source_rows if is_st_name(row["name"])})
    visible_cycles, latest = observed_cycles(all_rows, all_dates, available_dates, attempted, start, end)
    rows = [r for r in all_rows if start <= r["date"] <= end]
    note = settings["scope_note"] + " 个股列表仅显示已收录的涨停日；空白不代表断板。"
    relations = stock_relationships(conn, code, start, end, settings)
    competition = relations["competition"]
    peers = [*competition["wins"], *competition["losses"], *relations["cooccurrences"]["rows"]]
    for round_record in competition["rounds"]:
        peers.extend(round_record["wins"])
        peers.extend(round_record["losses"])
        peers.extend(round_record["cohort"])
    # Current company profiles are presentation metadata. Historical names,
    # cohort membership and win/loss evidence remain untouched.
    profiles = {peer["code"]: {"code": peer["code"]} for peer in peers}
    unique_profiles = list(profiles.values())
    for offset in range(0, len(unique_profiles), 500):
        enrich_stock_profiles(conn, unique_profiles[offset:offset + 500])
    for peer in peers:
        peer.update(profiles[peer["code"]])
        peer["initials"] = stock_initials(peer["name"])
    return {"stock": stock, "range_start": start, "range_end": end, "as_of_date": latest,
            "stats": {"limit_days": len(rows), "max_boards": max((r["boards"] for r in rows), default=0), "cycles": len(visible_cycles)},
            "cycles": list(reversed(visible_cycles)), "rows": list(reversed(rows)), "coverage_note": note,
            "relationships": relations}
