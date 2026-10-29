"""Time conventions shared by source selection and archive scheduling."""
from datetime import datetime, time, timedelta, timezone

TZ = timezone(timedelta(hours=8))
CLOSE_READY = time(15, 30)


def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def target_day(now=None):
    current = (now or datetime.now(TZ)).astimezone(TZ)
    day = current.date()
    if current.time() < CLOSE_READY:
        day -= timedelta(days=1)
    return day.isoformat()
