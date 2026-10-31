"""Daily exchange-calendar refresh; failures never discard offline evidence."""
from datetime import datetime, timedelta
from lianban.core.clock import TZ
from lianban.storage.settings import get_settings, set_settings


def refresh(conn, *, now=None):
    from lianban.adapters.providers.exchange_calendar import fetch_calendar
    current = (now or datetime.now(TZ)).astimezone(TZ)
    settings = get_settings(conn)
    checked = settings.get("exchange_calendar_checked_at")
    if checked and current - datetime.fromisoformat(checked) < timedelta(days=1):
        return
    try:
        annual = fetch_calendar()
        if not current.year - 1 <= annual["year"] <= current.year + 1:
            raise ValueError("交易所返回的年度日历已过期")
        calendars = dict(settings.get("exchange_calendars") or {})
        calendars[str(annual.pop("year"))] = annual
        set_settings(conn, exchange_calendars=calendars, exchange_calendar_error=None,
                     exchange_calendar_checked_at=current.isoformat(timespec="seconds"))
    except (ValueError, OSError) as exc:
        set_settings(conn, exchange_calendar_error=str(exc),
                     exchange_calendar_checked_at=current.isoformat(timespec="seconds"))
