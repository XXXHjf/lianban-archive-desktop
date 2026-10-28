"""Minute polling for the local test edition; provisional facts stay out of events."""
from contextlib import closing
from datetime import datetime, time, timedelta
from pathlib import Path
import json
import threading

import database as db

INTERVAL = 60
NOTE = "盘中暂定数据，每分钟检查；涨停及连板高度可能变化，收盘确认后才计入历史、晋级和竞争统计。"


def polling_time(now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    clock = current.time()
    # Retain minute checks through lunch, so a service started at noon can
    # immediately display the morning snapshot too.
    return current.weekday() < 5 and time(9, 30) <= clock < time(15, 30)


def next_check_at(now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    return current.replace(second=0, microsecond=0) + timedelta(minutes=1)


def minute_refresh_due(day, fetched_at, *, now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    if day != current.date().isoformat() or current.weekday() >= 5:
        return False
    # Catch up the final bar even when the service is reopened after 15:30.
    if current.time() >= time(15) and (not fetched_at or datetime.fromisoformat(fetched_at).astimezone(db.TZ).time() < time(15)):
        return True
    if not polling_time(current):
        return False
    return not fetched_at or current - datetime.fromisoformat(fetched_at) >= timedelta(seconds=55)


def snapshot(conn, day):
    # A confirmed close always supersedes the provisional pool, atomically from
    # the reader's point of view. Old snapshots remain available for auditing.
    row = conn.execute("SELECT p.* FROM live_pools p WHERE p.date=? AND NOT EXISTS "
                       "(SELECT 1 FROM days d WHERE d.date=p.date AND d.status='ok')", (day,)).fetchone()
    if not row:
        return None
    return {**dict(row), "records": json.loads(row["records_json"])}


def save_snapshot(conn, result, *, now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    if result.date != current.date().isoformat():
        raise ValueError("盘中快照日期必须是北京时间当天")
    if result.status != "ok" or not result.records:
        return False
    clean = db.validated_records(result.date, result.records, result.source)
    stamp = current.isoformat(timespec="seconds")
    with conn:
        if conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (result.date,)).fetchone():
            return False
        conn.execute("INSERT INTO live_pools VALUES (?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
                     "records_json=excluded.records_json,source=excluded.source,fetched_at=excluded.fetched_at,"
                     "raw_path=excluded.raw_path,note=excluded.note",
                     (result.date, json.dumps(clean, ensure_ascii=False, allow_nan=False), result.source,
                      stamp, result.raw_path, NOTE))
        # Make newly listed symbols searchable/editable without adding a single
        # provisional observation to the historical fact tables.
        conn.executemany("INSERT OR IGNORE INTO stocks VALUES (?,?,?,?)",
                         [(r["code"], r["name"], r["market"], result.date) for r in clean])
    return True


def metadata(conn, *, now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    settings = db.get_settings(conn)
    today = current.date().isoformat()
    dates = [r[0] for r in conn.execute("SELECT p.date FROM live_pools p WHERE p.date<=? AND NOT EXISTS "
             "(SELECT 1 FROM days d WHERE d.date=p.date AND d.status='ok') ORDER BY p.date", (today,))]
    if settings.get("live_calendar_date") == today and settings.get("live_is_trading_day"):
        dates = sorted(set([*dates, today]))
    latest = dates[-1] if dates else None
    pool = snapshot(conn, latest) if latest else None
    return {"enabled": True, "interval": INTERVAL, "today": today, "dates": dates, "date": latest,
            "status": settings.get("live_update_status", "starting"),
            "polling": polling_time(current) and settings.get("live_calendar_date") == today and bool(settings.get("live_is_trading_day")),
            "fetched_at": pool["fetched_at"] if pool else None, "source": pool["source"] if pool else None,
            "checked_at": settings.get("live_update_checked_at"), "count": len(pool["records"]) if pool else None,
            "note": NOTE, "error": settings.get("live_update_error"),
            "stale": bool(pool and current - datetime.fromisoformat(pool["fetched_at"]) > timedelta(minutes=3))}


def refresh(path=db.DEFAULT_DB, *, now=None):
    from provider import ProviderError, fetch_live_day, trading_dates

    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    checked_at = current.isoformat(timespec="seconds")
    today = current.date().isoformat()
    with closing(db.connect(path)) as conn:
        if not polling_time(current):
            db.set_settings(conn, live_update_status="paused", live_update_checked_at=checked_at)
            return
        settings = db.get_settings(conn)
        raw_dir = Path(path).resolve().parent / "raw"
        try:
            # An index's first daily bar can arrive after 09:30. Cache positive
            # evidence for the day; retry a negative result on the next minute.
            if settings.get("live_calendar_date") != today or not settings.get("live_is_trading_day"):
                dates, _ = trading_dates((current.date() - timedelta(days=14)).isoformat(), today, raw_dir=raw_dir)
                db.set_settings(conn, live_calendar_date=today, live_is_trading_day=today in dates)
            else:
                dates = [today] if settings.get("live_is_trading_day") else []
            if today not in dates or conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (today,)).fetchone():
                db.set_settings(conn, live_update_status="paused", live_update_checked_at=checked_at)
                return
            result = fetch_live_day(today, raw_dir=raw_dir, now=current)
            saved = save_snapshot(conn, result, now=current)
            db.set_settings(conn, live_update_status="current" if saved else "waiting",
                            live_update_checked_at=checked_at, live_update_error=None)
        except (ProviderError, ValueError) as exc:
            db.set_settings(conn, live_update_status="error", live_update_checked_at=checked_at, live_update_error=str(exc))


class Refresher:
    def __init__(self, path):
        self.path = path
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="local-minute-pool", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.is_set():
            try:
                refresh(self.path)
            except Exception as exc:
                with closing(db.connect(self.path)) as conn:
                    db.set_settings(conn, live_update_status="error", live_update_checked_at=db.now_iso(), live_update_error=str(exc))
            self._stop.wait(max(0, (next_check_at() - datetime.now(db.TZ)).total_seconds()))
