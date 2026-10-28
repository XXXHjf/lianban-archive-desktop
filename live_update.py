"""Keep the closing-pool archive current while the local server is running."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, time, timedelta
from pathlib import Path
import threading

import database as db

CHECK_SECONDS = 5 * 60
CLOSE_READY = time(15, 30)


def next_check_at(now=None):
    """Align checks to the clock so a restart never shifts the 15:30 run."""
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    return current.replace(second=0, microsecond=0) + timedelta(minutes=5 - current.minute % 5)


def target_day(now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    day = current.date()
    if current.time() < CLOSE_READY:
        day -= timedelta(days=1)
    return day.isoformat()


def refresh(path=db.DEFAULT_DB, *, now=None, stop=None):
    # Import the network dependencies here so offline queries still start even
    # on a computer that has not installed the optional sync dependencies.
    from provider import (CALENDAR_SOURCE, CALENDAR_URL, SOURCE, SUMMARY_SOURCE, CLS_SOURCE, POOL_URL,
                          METHOD_NOTE, SCOPE_NOTE, ProviderError, fetch_day, trading_dates)
    from sync_data import archive_coverage

    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    checked_at = current.isoformat(timespec="seconds")
    end = target_day(current)
    raw_dir = Path(path).resolve().parent / "raw"
    with closing(db.connect(path)) as conn:
        settings = db.get_settings(conn)
        last = conn.execute("SELECT MAX(date) FROM days WHERE status='ok' AND date<=?", (end,)).fetchone()[0]
        start = (datetime.fromisoformat(last).date() - timedelta(days=7)).isoformat() if last else settings["range_start"]
        if start > end:
            return
        db.set_settings(conn, auto_update_status="updating", auto_update_started_at=checked_at,
                        auto_update_target=end, auto_update_interval=CHECK_SECONDS,
                        auto_update_time=CLOSE_READY.strftime("%H:%M"), auto_update_timezone="Asia/Shanghai")

        # Bound each calendar request below its 1,000-bar response limit, even
        # when a new installation needs to catch up several years.
        fresh_days, raw_paths = set(), []
        cursor = datetime.fromisoformat(start).date()
        finish = datetime.fromisoformat(end).date()
        while cursor <= finish:
            if stop and stop.is_set():
                return
            chunk_end = min(cursor + timedelta(days=365), finish)
            days, raw = trading_dates(cursor.isoformat(), chunk_end.isoformat(), raw_dir=raw_dir)
            fresh_days.update(days)
            raw_paths.append(raw)
            cursor = chunk_end + timedelta(days=1)
        calendar = sorted(set(settings.get("calendar_dates") or []) | fresh_days)
        db.set_settings(conn, range_end=max(settings["range_end"], end),
                        calendar_dates=calendar, calendar_source=CALENDAR_SOURCE,
                        calendar_url=CALENDAR_URL, calendar_raw_path=raw_paths[-1],
                        source=SUMMARY_SOURCE, source_url=POOL_URL, scope_note=SCOPE_NOTE, method_note=METHOD_NOTE)
        expected = [day for day in calendar if settings["range_start"] <= day <= end]
        statuses = {r["date"]: dict(r) for r in conn.execute("SELECT date,status,fetched_at,source FROM days")}
        # Retry every known gap. Recheck recent successful snapshots hourly for
        # source corrections, without rewriting unchanged facts or tag overrides.
        recent = set(expected[-2:])
        day_checks = settings.get("auto_update_day_checks") or {}
        candidates = []
        ready_at = datetime.combine(current.date(), CLOSE_READY, tzinfo=db.TZ)
        for day in expected:
            previous = statuses.get(day)
            checked = day_checks.get(day) or (previous["fetched_at"] if previous else checked_at)
            stale = previous and current - datetime.fromisoformat(checked) >= timedelta(hours=1)
            # A retained CLS snapshot must not be revised using a different
            # provider's suspension/continuity convention on the following day.
            if previous and previous["status"] == "ok" and previous["source"] == CLS_SOURCE and day != current.date().isoformat():
                continue
            # Recheck today's pool at 15:30 even if an older configuration or
            # manual sync saved a snapshot before the configured cutoff.
            due_today = (day == current.date().isoformat() and current >= ready_at
                         and datetime.fromisoformat(checked) < ready_at)
            if not previous or previous["status"] != "ok" or (day in recent and stale) or due_today:
                candidates.append(day)
        # Fetch the newest session before retrying old historical gaps.
        candidates.reverse()
        errors = []
        for index, day in enumerate(candidates):
            if stop and stop.is_set():
                return
            try:
                result = fetch_day(day, raw_dir=raw_dir)
                previous = statuses.get(day)
                if previous and previous["status"] == "ok" and previous["source"] == CLS_SOURCE and result.source != CLS_SOURCE:
                    # A fallback outage is not a reason to replace confirmed
                    # CLS facts with another provider's board-count convention.
                    continue
                old_rows = [dict(r) for r in conn.execute("SELECT * FROM events WHERE date=? ORDER BY code", (day,))]
                new_rows = sorted(result.records, key=lambda r: r["code"])
                if result.status != "ok" or new_rows != old_rows:
                    db.save_day(conn, day, result.records, result.source, status=result.status,
                                note=result.note, raw_path=result.raw_path)
                if result.status == "ok":
                    day_checks[day] = checked_at
            except ProviderError as exc:
                errors.append(f"{day}: {exc}")
                db.save_day(conn, day, [], SOURCE, status="failed", note=str(exc), raw_path=exc.raw_path)
            if index + 1 < len(candidates):
                if stop:
                    if stop.wait(0.8):
                        return
                else:
                    threading.Event().wait(0.8)
        summary, _ = archive_coverage(conn, expected, CALENDAR_SOURCE)
        missing = summary["missing_dates"]
        update_status = "error" if errors else "waiting" if missing else "current"
        db.set_settings(conn, **summary, auto_update_status=update_status,
                        auto_update_checked_at=checked_at,
                        auto_update_expected=expected[-1] if expected else None,
                        auto_update_day_checks={day: value for day, value in day_checks.items() if day in recent},
                        auto_update_pending=missing, auto_update_error="；".join(errors) or None,
                        auto_update_next_at=next_check_at(current).isoformat(timespec="seconds"))


class Refresher:
    def __init__(self, path, on_update=None):
        self.path = path
        self.on_update = on_update
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="archive-auto-update", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.is_set():
            try:
                refresh(self.path, stop=self._stop)
                if self.on_update and not self._stop.is_set():
                    self.on_update()
            except Exception as exc:
                # Network, calendar and validation failures keep confirmed facts.
                with closing(db.connect(self.path)) as conn:
                    db.set_settings(conn, auto_update_status="error", auto_update_error=str(exc),
                                    auto_update_checked_at=db.now_iso(), auto_update_interval=CHECK_SECONDS,
                                    auto_update_time=CLOSE_READY.strftime("%H:%M"), auto_update_timezone="Asia/Shanghai")
            next_at = next_check_at()
            with closing(db.connect(self.path)) as conn:
                db.set_settings(conn, auto_update_next_at=next_at.isoformat(timespec="seconds"))
            self._stop.wait(max(0, (next_at - datetime.now(db.TZ)).total_seconds()))
