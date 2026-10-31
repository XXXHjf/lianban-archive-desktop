"""Minute polling for the local test edition; provisional facts stay out of events."""
from contextlib import closing
from datetime import datetime, time, timedelta
from pathlib import Path
import json
import threading

from lianban.config import DEFAULT_DB
from lianban.core.clock import TZ, now_iso
from lianban.core.stock import is_st_name, validated_records
from lianban.core.trading_calendar import is_trading_day
from lianban.storage import connect
from lianban.storage.settings import get_settings, set_settings
from lianban.storage.trading_calendar import context as calendar_context

INTERVAL = 60
NOTE = "盘中暂定数据，每分钟检查；涨停及连板高度可能变化，收盘确认后才计入历史、晋级和竞争统计。"


def polling_time(now=None, *, known_dates=(), calendars=None):
    current = (now or datetime.now(TZ)).astimezone(TZ)
    clock = current.time()
    # Retain minute checks through lunch, so a service started at noon can
    # immediately display the morning snapshot too.
    return (is_trading_day(current.date().isoformat(), known_dates=known_dates, calendars=calendars) is True
            and time(9, 30) <= clock < time(15, 30))


def next_check_at(now=None):
    current = (now or datetime.now(TZ)).astimezone(TZ)
    return current.replace(second=0, microsecond=0) + timedelta(minutes=1)


def minute_refresh_due(day, fetched_at, *, now=None, known_dates=(), calendars=None):
    current = (now or datetime.now(TZ)).astimezone(TZ)
    if (day != current.date().isoformat()
            or is_trading_day(day, known_dates=known_dates, calendars=calendars) is not True):
        return False
    # Catch up the final bar even when the service is reopened after 15:30.
    if current.time() >= time(15) and (not fetched_at or datetime.fromisoformat(fetched_at).astimezone(TZ).time() < time(15)):
        return True
    if not polling_time(current, known_dates=known_dates, calendars=calendars):
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
    current = (now or datetime.now(TZ)).astimezone(TZ)
    if result.date != current.date().isoformat():
        raise ValueError("盘中快照日期必须是北京时间当天")
    if result.status != "ok" or not result.records:
        return False
    clean = validated_records(result.date, result.records, result.source)
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
    current = (now or datetime.now(TZ)).astimezone(TZ)
    settings = get_settings(conn)
    calendar = calendar_context(conn, now=current)
    calendar_date = calendar["calendar_date"]
    today = calendar["latest_trade_date"]
    dates = [r[0] for r in conn.execute("SELECT p.date FROM live_pools p WHERE p.date<=? AND NOT EXISTS "
             "(SELECT 1 FROM days d WHERE d.date=p.date AND d.status='ok') ORDER BY p.date", (calendar_date,))]
    if (today == calendar_date and today in calendar["dates"]
            and not conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (today,)).fetchone()):
        dates = sorted(set([*dates, today]))
    latest = dates[-1] if dates else None
    pool = snapshot(conn, latest) if latest else None
    polling = calendar["is_trading_day"] is True and time(9, 30) <= current.time() < time(15, 30)
    return {"enabled": True, "interval": INTERVAL, "today": today, "calendar_date": calendar_date, "dates": dates, "date": latest,
            "status": settings.get("live_update_status", "starting"),
            "polling": polling,
            "fetched_at": pool["fetched_at"] if pool else None, "source": pool["source"] if pool else None,
            "checked_at": settings.get("live_update_checked_at"), "count": sum(not is_st_name(row["name"]) for row in pool["records"]) if pool else None,
            "note": NOTE, "error": settings.get("live_update_error"),
            "stale": bool(polling and pool and latest == calendar_date
                          and current - datetime.fromisoformat(pool["fetched_at"]) > timedelta(minutes=3))}


def refresh(path=DEFAULT_DB, *, now=None):
    from lianban.adapters.providers.pools import ProviderError, fetch_live_day, trading_dates
    from lianban.ingestion.trading_calendar import refresh as refresh_calendar

    current = (now or datetime.now(TZ)).astimezone(TZ)
    checked_at = current.isoformat(timespec="seconds")
    today = current.date().isoformat()
    with closing(connect(path)) as conn:
        # Refresh the annual official calendar before deciding whether a newly
        # announced year can be polled. A calendar outage retains cached facts.
        refresh_calendar(conn, now=current)
        calendar = calendar_context(conn, now=current)
        if not time(9, 30) <= current.time() < time(15, 30):
            set_settings(conn, live_update_status="paused", live_update_checked_at=checked_at)
            return
        raw_dir = Path(path).resolve().parent / "raw"
        try:
            opened = calendar["is_trading_day"]
            if opened is None:
                dates, _ = trading_dates((current.date() - timedelta(days=14)).isoformat(), today, raw_dir=raw_dir)
                settings = get_settings(conn)
                set_settings(conn, calendar_dates=sorted(set(settings.get("calendar_dates") or []) | set(dates)))
                opened = today in dates
            set_settings(conn, live_calendar_date=today, live_is_trading_day=opened is True)
            if not opened or conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (today,)).fetchone():
                set_settings(conn, live_update_status="paused", live_update_checked_at=checked_at)
                return
            result = fetch_live_day(today, raw_dir=raw_dir, now=current)
            saved = save_snapshot(conn, result, now=current)
            set_settings(conn, live_update_status="current" if saved else "waiting",
                            live_update_checked_at=checked_at, live_update_error=None)
        except (ProviderError, ValueError) as exc:
            set_settings(conn, live_update_status="error", live_update_checked_at=checked_at, live_update_error=str(exc))


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
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)

    def _run(self):
        while not self._stop.is_set():
            try:
                refresh(self.path)
            except Exception as exc:
                with closing(connect(self.path)) as conn:
                    set_settings(conn, live_update_status="error", live_update_checked_at=now_iso(), live_update_error=str(exc))
            self._stop.wait(max(0, (next_check_at() - datetime.now(TZ)).total_seconds()))
