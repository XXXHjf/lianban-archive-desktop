"""Wall-clock alignment for archive collection."""
from datetime import datetime, timedelta
from lianban.core.clock import TZ

def next_check_at(now=None):
    """Align checks to the clock so a restart never shifts the 15:30 run."""
    current = (now or datetime.now(TZ)).astimezone(TZ)
    return current.replace(second=0, microsecond=0) + timedelta(minutes=5 - current.minute % 5)
