"""A-share sessions: weekends stay closed even on compensatory workdays.

Unknown years are deliberately not guessed from weekdays. Verified index bars
can establish individual sessions until an annual exchange calendar is available.
"""
from datetime import date, timedelta
from functools import lru_cache

# Shanghai Stock Exchange annual notices, also applicable to SZSE A shares.
OFFICIAL_RANGES = {
    2025: (("01-01", "01-01"), ("01-28", "02-04"), ("04-04", "04-06"),
           ("05-01", "05-05"), ("05-31", "06-02"), ("10-01", "10-08")),
    2026: (("01-01", "01-03"), ("02-15", "02-23"), ("04-04", "04-06"),
           ("05-01", "05-05"), ("06-19", "06-21"), ("09-25", "09-27"),
           ("10-01", "10-07")),
}
OFFICIAL_SOURCES = {
    2025: "https://www.sse.com.cn/disclosure/announcement/general/c/c_20241223_10767108.shtml",
    2026: "https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml",
}


def date_range(start, end):
    cursor, finish = date.fromisoformat(start), date.fromisoformat(end)
    while cursor <= finish:
        yield cursor.isoformat()
        cursor += timedelta(days=1)


@lru_cache(maxsize=8)
def bundled_closed_dates(year):
    return frozenset(day for start, end in OFFICIAL_RANGES.get(year, ())
                     for day in date_range(f"{year}-{start}", f"{year}-{end}"))


def is_trading_day(day, *, known_dates=(), calendars=None):
    value = date.fromisoformat(day)
    if value.weekday() >= 5:
        return False
    annual = (calendars or {}).get(str(value.year))
    if annual is not None:
        return day not in annual["closed_dates"]
    if value.year in OFFICIAL_RANGES:
        return day not in bundled_closed_dates(value.year)
    return True if day in known_dates else None


def latest_trading_day(day, *, known_dates=(), calendars=None):
    # Limit the search to years supported by a complete exchange calendar or
    # individual dated evidence. A missing year must not fabricate sessions.
    known = set(known_dates)
    years = set(OFFICIAL_RANGES) | {int(year) for year in (calendars or {})}
    candidates = [value for value in known if value <= day and
                  is_trading_day(value, known_dates=known, calendars=calendars) is True]
    for year in years:
        if year > int(day[:4]):
            continue
        cursor = date.fromisoformat(min(day, f"{year}-12-31"))
        while cursor.year == year:
            value = cursor.isoformat()
            if is_trading_day(value, known_dates=known, calendars=calendars) is True:
                candidates.append(value)
                break
            cursor -= timedelta(days=1)
    return max(candidates, default=None)
