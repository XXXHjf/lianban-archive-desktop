"""Batch minute collection use case; the CLI only parses arguments."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from datetime import datetime
import hashlib
import json
from pathlib import Path
import time
import lianban.storage.api as db
from lianban.core.clock import TZ, now_iso
from . import api as intraday

def fetch_stock(events, raw_dir):
    import requests
    code = events[0]["code"]
    market = 1 if code.startswith("6") else 0
    symbol = ("sh" if market else "bj" if code.startswith(("4", "8", "92")) else "sz") + code
    errors, partials = {}, {}
    sources = [
        ("东方财富分时", intraday.EASTMONEY_URL, {"secid": f"{market}.{code}", "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11", "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "ndays": 5, "iscr": 0}, intraday.normalize_eastmoney),
        ("腾讯财经分时", intraday.TENCENT_URL, {"code": symbol}, intraday.normalize_tencent),
    ]
    remaining, results = list(events), []
    for source, url, params, normalize in sources:
        if not remaining:
            break
        response = None
        for attempt in range(2):
            try:
                response = requests.get(url, params=params, timeout=(6, 15), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"})
                response.raise_for_status()
                payload = response.json()
                break
            except (requests.RequestException, ValueError) as exc:
                if attempt == 1:
                    errors.update({e["date"]: f"{source}请求失败：{type(exc).__name__}" for e in remaining})
                    response = None
                else:
                    time.sleep(0.5)
        if response is None:
            continue
        digest = hashlib.sha256(response.content).hexdigest()[:12]
        raw_path = raw_dir / f"{'eastmoney' if '东方' in source else 'tencent'}_{code}_{datetime.now(TZ):%Y%m%dT%H%M%S%f}_{digest}.json"
        raw_path.write_bytes(response.content)
        retry = []
        for event in remaining:
            try:
                points = normalize(payload, event)
                status, _ = intraday.validate_points(points, event)
                item = (event, points, source, str(raw_path))
                if status == "ok":
                    results.append(item)
                else:
                    if event["date"] not in partials or len(points) > len(partials[event["date"]][1]):
                        partials[event["date"]] = item
                    retry.append(event)
            except (ValueError, TypeError, KeyError) as exc:
                errors[event["date"]] = f"{source}：{exc}"
                retry.append(event)
        remaining = retry
    for event in remaining:
        if event["date"] in partials:
            results.append(partials[event["date"]])
        else:
            errors.setdefault(event["date"], "未获取到有效分时数据")
    successes = {item[0]["date"] for item in results}
    return results, [(event, errors[event["date"]]) for event in events if event["date"] not in successes]


def collect(archive_path, dates, *, force=False, workers=3):
    dates = sorted(set(intraday.validate_day(day) for day in dates))
    with closing(db.connect(archive_path)) as archive:
        events = []
        for day in dates:
            status = archive.execute("SELECT status FROM days WHERE date=?", (day,)).fetchone()
            if not status or status["status"] != "ok":
                raise ValueError(f"{day} 尚无通过校验的收盘涨停池，请先更新档案")
            events.extend(dict(r) for r in archive.execute("SELECT * FROM events WHERE date=? ORDER BY code", (day,)) if not db.is_st_name(r["name"]))
    raw_dir = Path(archive_path).resolve().parent / "intraday_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    with closing(intraday.initialize(intraday.store_path(archive_path))) as conn:
        existing = {(r[0], r[1]) for r in conn.execute("SELECT date,code FROM sessions WHERE status='ok'")}
        groups = {}
        for event in events:
            if force or (event["date"], event["code"]) not in existing:
                groups.setdefault(event["code"], []).append(event)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            jobs = {pool.submit(fetch_stock, group, raw_dir): group for group in groups.values()}
            for index, job in enumerate(as_completed(jobs), 1):
                group = jobs[job]
                try:
                    results, failures = job.result()
                except Exception as exc:
                    results, failures = [], [(event, f"采集失败：{type(exc).__name__}: {exc}") for event in group]
                for event, points, source, raw_path in results:
                    intraday.save_session(conn, event, points, source, raw_path)
                for event, message in failures:
                    intraday.save_error(conn, event["date"], event["code"], message)
                print(f"{index}/{len(jobs)} {group[0]['code']} saved={len(results)} failed={len(failures)}", flush=True)
    cached, errors = intraday._cached(archive_path)
    summaries = []
    for day in dates:
        rows = [{**event, "status": cached.get((day, event["code"]), {}).get("status", "missing"), "error": errors.get((day, event["code"]), "")} for event in events if event["date"] == day]
        summaries.append({"date": day, "rows": rows, "total": len(rows),
                          "ready": sum(r["status"] == "ok" for r in rows),
                          "partial": sum(r["status"] == "partial" for r in rows),
                          "missing": sum(r["status"] == "missing" for r in rows)})
    report = {"collected_at": now_iso(), "scope_note": "本次只采集所选日期的本地收盘涨停池，已剔除 ST、*ST，保留来源中的创业板等记录。",
              "days": [{k: v for k, v in summary.items() if k != "rows"} | {"failures": [r for r in summary["rows"] if r["status"] != "ok"]} for summary in summaries]}
    report_path = Path(archive_path).resolve().parent / f"intraday-report-{datetime.now(TZ):%Y%m%dT%H%M%S}.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    return report
