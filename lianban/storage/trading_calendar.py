"""Read-only calendar composition; never fetch sources from query handlers."""
from datetime import datetime
from lianban.core.clock import TZ
from lianban.core.trading_calendar import (OFFICIAL_RANGES, OFFICIAL_SOURCES, date_range,
                                         is_trading_day, latest_trading_day)
from .settings import get_settings


def evidence(conn):
    settings = get_settings(conn)
    known = set(settings.get("calendar_dates") or [])
    known.update(row[0] for row in conn.execute("SELECT date FROM days WHERE status='ok'"))
    if settings.get("live_is_trading_day") and settings.get("live_calendar_date"):
        known.add(settings["live_calendar_date"])
    return known, settings.get("exchange_calendars") or {}


def context(conn, *, now=None):
    current = (now or datetime.now(TZ)).astimezone(TZ)
    today = current.date().isoformat()
    known, calendars = evidence(conn)
    years = set(OFFICIAL_RANGES) | {int(year) for year in calendars}
    dates = {day for day in known if is_trading_day(day, known_dates=known, calendars=calendars) is True}
    for year in years:
        dates.update(day for day in date_range(f"{year}-01-01", f"{year}-12-31")
                     if is_trading_day(day, calendars=calendars) is True)
    ordered = sorted(dates)
    return {"dates": ordered, "start": ordered[0] if ordered else None,
            "end": ordered[-1] if ordered else None, "calendar_date": today,
            "latest_trade_date": latest_trading_day(today, known_dates=known, calendars=calendars),
            "is_trading_day": is_trading_day(today, known_dates=known, calendars=calendars),
            "year_confirmed": current.year in years,
            "source": "交易所年度休市安排 / 已核验指数交易日",
            "sources": [*OFFICIAL_SOURCES.values(), *(row["source"] for row in calendars.values())]}


def valid_session(conn, day):
    known, calendars = evidence(conn)
    return is_trading_day(day, known_dates=known, calendars=calendars) is True
