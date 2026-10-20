"""Archive a requested date range, gently, with validation and resume support."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
import json
import time
from contextlib import closing

import industry
import registration
from live_update import target_day

from database import DEFAULT_DB, REQUEST_START, REQUEST_END, connect, get_settings, set_settings, save_day
from provider import (SOURCE, SUMMARY_SOURCE, POOL_URL, CALENDAR_URL, CALENDAR_SOURCE, SCOPE_NOTE, METHOD_NOTE,
                      TZ, ProviderError, fetch_day, trading_dates, valid_day)


def weekdays(start: str, end: str) -> list[str]:
    day, finish = date.fromisoformat(start), date.fromisoformat(end)
    result = []
    while day <= finish:
        if day.weekday() < 5:
            result.append(day.isoformat())
        day += timedelta(days=1)
    return result


def archive_calendar(start, end):
    """Bound multi-year calendar queries below the provider's 1,000-bar limit."""
    cursor, finish = date.fromisoformat(start), date.fromisoformat(end)
    all_days, raw_paths = set(), []
    while cursor <= finish:
        chunk_end = min(cursor + timedelta(days=365), finish)
        # Keep a short final tail in this request, avoiding a standalone request
        # that consists only of a weekend or exchange holiday.
        if finish - chunk_end < timedelta(days=31):
            chunk_end = finish
        days, raw_path = trading_dates(cursor.isoformat(), chunk_end.isoformat())
        all_days.update(days)
        raw_paths.append(raw_path)
        cursor = chunk_end + timedelta(days=1)
        if cursor <= finish:
            time.sleep(0.8)
    return sorted(all_days), raw_paths


def archive_coverage(conn, candidate_days, calendar_source):
    """Coverage belongs to the entire archive, including on a bounded retry."""
    settings = get_settings(conn)
    start, end = settings["range_start"], settings["range_end"]
    calendar = set(settings.get("calendar_dates") or [])
    if calendar_source != CALENDAR_SOURCE:
        calendar.update(candidate_days)
    expected = sorted(day for day in calendar if start <= day <= end)
    statuses = {row["date"]: row["status"] for row in conn.execute(
        "SELECT date,status FROM days WHERE date BETWEEN ? AND ?", (start, end))}
    missing = [day for day in expected if statuses.get(day) != "ok"]
    confirmed = sorted(day for day, status in statuses.items() if status == "ok")
    counts = Counter(statuses.get(day, "missing") for day in expected)
    complete = bool(expected) and not missing and calendar_source == CALENDAR_SOURCE
    note = (f"已核验 {len(confirmed)} 个档案范围内来源日期；最新为 {max(confirmed) if confirmed else '暂无'}。"
            + ("辅助交易日历内截至该日的来源池已归档。" if complete else f"仍有 {len(missing)} 个候选日期空返回或失败，保留为数据缺口。")
            + "覆盖范围以选股宝原始池为准，非交易所全量认证。")
    return {"coverage_status": "complete" if complete else "partial", "coverage_note": note,
            "latest_date": max(confirmed) if confirmed else None, "missing_dates": missing}, dict(counts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default=(date.fromisoformat(REQUEST_START) - timedelta(days=31)).isoformat(),
                        help="Include one month of warmup history before the archive range")
    parser.add_argument("--end", default=target_day(),
                        help="上海时间 15:30 后包含当天，此前截至昨天；避免归档尚未发布的当天来源池")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--interval", type=float, default=0.8)
    parser.add_argument("--refresh", action="store_true", help="Explicitly re-fetch already validated days")
    args = parser.parse_args()
    valid_day(args.start)
    valid_day(args.end)
    if args.start > args.end or args.interval < 0.3:
        parser.error("开始日期不得晚于结束日期；请求间隔不得低于 0.3 秒")
    conn = connect(args.db)
    existing_settings = get_settings(conn)
    set_settings(conn, range_start=min(REQUEST_START, existing_settings["range_start"]),
                 range_end=max(REQUEST_END, existing_settings["range_end"], args.end),
                 warmup_start=min(args.start, existing_settings.get("warmup_start") or args.start),
                 source=SUMMARY_SOURCE, source_url=POOL_URL,
                 scope_note=SCOPE_NOTE, method_note=METHOD_NOTE, coverage_status="syncing",
                 coverage_note="正在按日归档并核验来源数据；失败或空返回保留为缺口。")
    try:
        days, calendar_raw_paths = archive_calendar(args.start, args.end)
        calendar_source = CALENDAR_SOURCE
        set_settings(conn, calendar_source=calendar_source, calendar_url=CALENDAR_URL,
                     calendar_raw_path=calendar_raw_paths[-1], calendar_raw_paths=calendar_raw_paths,
                     calendar_dates=sorted(set(existing_settings.get("calendar_dates") or []) | set(days)))
        print(f"辅助日历：{len(days)} 个指数日线日期，{days[0]} 至 {days[-1]}。", flush=True)
    except ProviderError as exc:
        days = weekdays(args.start, args.end)
        calendar_source = "工作日候选日期（交易日历获取失败，空数据保留为未知）"
        set_settings(conn, calendar_source=calendar_source,
                     calendar_dates=existing_settings.get("calendar_dates") or [])
        print(f"辅助交易日历不可用：{exc}；改为温和请求工作日候选日期。", flush=True)
    skipped = 0
    for index, day in enumerate(days, start=1):
        previous = conn.execute("SELECT status,count FROM days WHERE date=?", (day,)).fetchone()
        if previous and previous["status"] == "ok" and not args.refresh:
            skipped += 1
            continue
        try:
            result = fetch_day(day)
            save_day(conn, day, result.records, result.source, status=result.status, note=result.note, raw_path=result.raw_path)
            print(f"[{index}/{len(days)}] {day} {result.status}: {len(result.records)} 条 {result.note}", flush=True)
        except ProviderError as exc:
            save_day(conn, day, [], SOURCE, status="failed", note=str(exc), raw_path=exc.raw_path)
            print(f"[{index}/{len(days)}] {day} failed: {exc}", flush=True)
        if index % 25 == 0:
            set_settings(conn, coverage_note=f"正在回补历史数据：已处理 {index}/{len(days)} 个候选交易日，当前到 {day}。原有确认数据继续保留。")
        time.sleep(args.interval)
    summary, counts = archive_coverage(conn, days, calendar_source)
    set_settings(conn, **summary)
    print(json.dumps({"done": True, "counts": counts, "skipped_ok": skipped, **summary}, ensure_ascii=False), flush=True)
    conn.close()
    try:
        with closing(connect(args.db)) as industry_conn:
            industry_last = get_settings(industry_conn).get("industry_fetched_at")
        if not industry_last or datetime.now(TZ) - datetime.fromisoformat(industry_last) >= industry.MAX_AGE:
            print(f"行业分类更新：{industry.refresh(args.db)} 只股票。", flush=True)
    except Exception as exc:
        print(f"行业更新未完成，保留已有缓存：{exc}", flush=True)
    try:
        with closing(connect(args.db)) as registration_conn:
            registration_settings = get_settings(registration_conn)
            registration_last = registration_settings.get("registration_fetched_at")
            stock_count = registration_conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0]
        if (not registration_last or datetime.now(TZ) - datetime.fromisoformat(registration_last) >= industry.MAX_AGE
                or stock_count > registration_settings.get("registration_requested", 0)):
            print(f"注册省份更新：{registration.refresh(args.db)} 只股票。", flush=True)
    except Exception as exc:
        print(f"注册省份更新未完成，保留已有缓存：{exc}", flush=True)
    return 0 if summary["coverage_status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
