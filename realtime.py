"""Minute-pool extension for frozen editions; confirmed history stays separate."""
from contextlib import closing
from datetime import datetime, time, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
import json
import math
import re
import threading

import database as db

NOTE = "盘中暂定数据，每分钟更新；收盘确认前不计入历史、晋级和竞争胜负。"
FIELDS = "date code name market industry boards close pct_change turnover first_time last_time open_times source".split()


def initialize(path):
    with closing(db.connect(path)) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS realtime_pools (
                date TEXT PRIMARY KEY, records_json TEXT NOT NULL, source TEXT NOT NULL,
                fetched_at TEXT NOT NULL, note TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS realtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)


def state(conn):
    return {r[0]: json.loads(r[1]) for r in conn.execute("SELECT key,value FROM realtime_state")}


def set_state(conn, **values):
    with conn:
        conn.executemany("INSERT INTO realtime_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         [(key, json.dumps(value, ensure_ascii=False)) for key, value in values.items()])


def confirmed(conn, day):
    return conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (day,)).fetchone() is not None


def snapshot(conn, day):
    row = conn.execute("SELECT p.* FROM realtime_pools p WHERE p.date=? AND NOT EXISTS "
                       "(SELECT 1 FROM days d WHERE d.date=p.date AND d.status='ok')", (day,)).fetchone()
    return {**dict(row), "records": json.loads(row["records_json"])} if row else None


def validate(day, records, source):
    if datetime.fromisoformat(day).date().isoformat() != day:
        raise ValueError("日期格式错误")
    clean, seen = [], set()
    for item in records:
        row = {key: item.get(key) for key in FIELDS}
        if row["date"] != day or not isinstance(row["code"], str) or not re.fullmatch(r"[0-9]{6}", row["code"]):
            raise ValueError("股票日期或代码不符合请求")
        if row["code"] in seen or not isinstance(row["name"], str) or not row["name"].strip():
            raise ValueError("股票重复或名称缺失")
        if isinstance(row["boards"], bool) or not isinstance(row["boards"], int) or not 1 <= row["boards"] <= 100:
            raise ValueError("连板数无效")
        for key in ("close", "pct_change", "turnover"):
            value = row[key]
            if value is not None and (isinstance(value, bool) or not math.isfinite(float(value))):
                raise ValueError("行情数值无效")
        if row["close"] is None or float(row["close"]) <= 0 or row["pct_change"] is None:
            raise ValueError("缺少有效价格或涨幅")
        row.update(source=source, market=db.market_for(row["code"]))
        seen.add(row["code"])
        clean.append(row)
    return clean


def save_pool(conn, day, records, source, *, now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    if day != current.date().isoformat():
        raise ValueError("盘中快照只能保存北京时间当天")
    clean = validate(day, records, source)
    if not clean or confirmed(conn, day):
        return False
    with conn:
        conn.execute("INSERT INTO realtime_pools VALUES (?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
                     "records_json=excluded.records_json,source=excluded.source,fetched_at=excluded.fetched_at,note=excluded.note",
                     (day, json.dumps(clean, ensure_ascii=False, allow_nan=False), source, current.isoformat(timespec="seconds"), NOTE))
        conn.executemany("INSERT OR IGNORE INTO stocks VALUES (?,?,?,?)",
                         [(r["code"], r["name"], r["market"], day) for r in clean])
    return True


def metadata(conn, *, now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    today, settings = current.date().isoformat(), state(conn)
    dates = [r[0] for r in conn.execute("SELECT p.date FROM realtime_pools p WHERE p.date<=? AND NOT EXISTS "
             "(SELECT 1 FROM days d WHERE d.date=p.date AND d.status='ok') ORDER BY p.date", (today,))]
    if settings.get("calendar_date") == today and settings.get("trading_day") and not confirmed(conn, today):
        dates = sorted(set([*dates, today]))
    latest = dates[-1] if dates else None
    pool = snapshot(conn, latest) if latest else None
    return {"enabled": True, "interval": 60, "today": today, "dates": dates, "date": latest,
            "status": settings.get("status", "starting"), "checked_at": settings.get("checked_at"),
            "fetched_at": pool["fetched_at"] if pool else None, "count": len(pool["records"]) if pool else None,
            "source": pool["source"] if pool else None, "note": NOTE,
            "stale": bool(pool and current - datetime.fromisoformat(pool["fetched_at"]) > timedelta(minutes=3))}


def date_view(conn, day, pool, args):
    """Only this connection sees temporary views. Persistent history is untouched."""
    conn.execute("CREATE TEMP TABLE realtime_events AS SELECT * FROM main.events WHERE 0")
    event_columns = [r[1] for r in conn.execute("PRAGMA main.table_info(events)")]
    conn.executemany("INSERT INTO realtime_events VALUES (" + ",".join("?" for _ in event_columns) + ")",
                     [tuple(row.get(key) for key in event_columns) for row in pool["records"]])
    conn.execute("CREATE TEMP TABLE realtime_days AS SELECT * FROM main.days WHERE 0")
    day_columns = [r[1] for r in conn.execute("PRAGMA main.table_info(days)")]
    info = {"date": day, "status": "ok", "source": pool["source"], "note": NOTE,
            "count": len(pool["records"]), "fetched_at": pool["fetched_at"]}
    conn.execute("INSERT INTO realtime_days VALUES (" + ",".join("?" for _ in day_columns) + ")",
                 tuple(info.get(key) for key in day_columns))
    # The day is strictly validated before entering these SQL literals.
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", day):
        raise ValueError("日期格式错误")
    for name in ("events", "days"):
        conn.execute(f"CREATE TEMP VIEW {name} AS SELECT * FROM main.{name} WHERE date<>'{day}' UNION ALL SELECT * FROM realtime_{name}")
    arg = lambda key, default="": args.get(key, [default])[0]
    result = db.date_view(conn, day, int(arg("min_boards", "1")), arg("market", "all"), arg("q")[:100],
                          arg("exclude_st", "0") == "1", int(arg("boards")) if arg("boards") else None,
                          exclude_gem=arg("exclude_gem", "0") == "1")
    result.update(provisional=True, data_status="provisional", fetched_at=pool["fetched_at"], coverage_note=NOTE)
    return result


def install(app):
    """Attach only query augmentation, leaving the frozen application files intact."""
    if getattr(app.read_api, "realtime_installed", False):
        return
    original = app.read_api

    def read_api(server, path):
        parsed = urlparse(path)
        enabled = getattr(server, "realtime", False) or not getattr(server, "read_only", False)
        if not enabled or parsed.path not in ("/api/meta", "/api/date"):
            return original(server, path)
        args = parse_qs(parsed.query)
        with closing(db.connect(server.db_path)) as conn:
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='realtime_pools'").fetchone():
                return original(server, path)
            live = metadata(conn)
            if parsed.path == "/api/date" and not args.get("date") and live["date"]:
                args["date"] = [live["date"]]
                path = "/api/date?" + urlencode({key: value[0] for key, value in args.items()})
            result = original(server, path)  # Keep the edition's route validation and capability policy.
            if parsed.path == "/api/meta":
                result["live"] = live
            else:
                day = result["date"]
                pool = snapshot(conn, day)
                if pool:
                    result = date_view(conn, day, pool, args)
                if day in live["dates"]:
                    result["live"] = live
            return result
    read_api.realtime_installed = True
    app.read_api = read_api


def fetch_pool(day, *, now=None):
    import provider
    import requests

    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    if day != current.date().isoformat():
        raise ValueError("盘中来源只能请求当天")
    failures = []
    for source, url, params, normalize in (
        (provider.CLS_SOURCE, provider.CLS_POOL_URL,
         {"app": "CailianpressWeb", "os": "web", "sv": "8.7.9", "type": "up_pool", "way": "last_px", "rever": 1}, provider.normalize_cls_pool),
        (provider.SOURCE, provider.POOL_URL, {"pool_name": "limit_up"}, lambda payload, day: provider.normalize_pool(payload, day)[0]),
    ):
        try:
            response = requests.get(url, params=params, headers={"User-Agent": provider.UA, "Referer": "https://www.cls.cn/" if source == provider.CLS_SOURCE else "https://xuangubao.cn/"}, timeout=(6, 15))
            response.raise_for_status()
            rows = validate(day, normalize(response.json(), day), source)
            if rows:
                return rows, source
        except (requests.RequestException, ValueError, provider.ProviderError) as exc:
            failures.append(type(exc).__name__)
    raise RuntimeError("盘中来源暂未取得有效数据：" + ",".join(failures))


def refresh(path, *, now=None, close_archive=False):
    import provider
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    today = current.date().isoformat()
    with closing(db.connect(path)) as conn:
        settings = state(conn)
        active = current.weekday() < 5 and time(9, 30) <= current.time() < time(15, 30)
        try:
            if active:
                if settings.get("calendar_date") != today or not settings.get("trading_day"):
                    days, _ = provider.trading_dates((current.date() - timedelta(days=14)).isoformat(), today,
                                                   raw_dir=Path(path).resolve().parent / "realtime-raw")
                    set_state(conn, calendar_date=today, trading_day=today in days)
                else:
                    days = [today]
                if today in days and not confirmed(conn, today):
                    rows, source = fetch_pool(today, now=current)
                    save_pool(conn, today, rows, source, now=current)
                    set_state(conn, status="current", checked_at=current.isoformat(timespec="seconds"))
                    return
            # Online edition confirms only new sessions, without rewriting existing history.
            pending = [r[0] for r in conn.execute("SELECT p.date FROM realtime_pools p WHERE p.date<=? AND NOT EXISTS "
                       "(SELECT 1 FROM days d WHERE d.date=p.date AND d.status='ok') ORDER BY p.date DESC", (today,))]
            if close_archive and current.time() >= time(15, 30) and current.weekday() < 5 and not confirmed(conn, today):
                if settings.get("calendar_date") != today or not settings.get("trading_day"):
                    days, _ = provider.trading_dates((current.date() - timedelta(days=14)).isoformat(), today,
                                                   raw_dir=Path(path).resolve().parent / "realtime-raw")
                    set_state(conn, calendar_date=today, trading_day=today in days)
                else:
                    days = [today]
                if today in days and today not in pending:
                    pending.insert(0, today)
            candidates = [day for day in pending if day < today or current.time() >= time(15, 30)] if close_archive else []
            if candidates:
                day = candidates[0]
                result = provider.fetch_day(day, raw_dir=Path(path).resolve().parent / "realtime-raw", now=current)
                if result.status != "ok" or not result.records:
                    raise RuntimeError("收盘来源尚未就绪")
                rows = validate(day, result.records, result.source)
                # The original archive writer performs its own full validation too.
                with conn:
                    if not confirmed(conn, day):
                        db.save_day(conn, day, rows, result.source, note=result.note, raw_path=result.raw_path)
                        existing = db.get_settings(conn)
                        db.set_settings(conn, range_end=max(existing["range_end"], day),
                                        calendar_dates=sorted(set(existing.get("calendar_dates", []) + [day])))
            set_state(conn, status="paused", checked_at=current.isoformat(timespec="seconds"))
        except Exception as exc:
            # Keep the successful pool and confirmed historical facts on every failure.
            set_state(conn, status="error", checked_at=current.isoformat(timespec="seconds"), error=type(exc).__name__)


class Refresher:
    def __init__(self, path, *, close_archive=False):
        self.path, self.close_archive = path, close_archive
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        initialize(self.path)
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self.run, name="minute-pool", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def run(self):
        while not self.stop_event.is_set():
            try:
                refresh(self.path, close_archive=self.close_archive)
            except Exception:
                pass  # Next minute retries without interrupting queries.
            current = datetime.now(db.TZ)
            next_at = current.replace(second=0, microsecond=0) + timedelta(minutes=1)
            self.stop_event.wait(max(0, (next_at - current).total_seconds()))
