from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from lianban.core.stock import validated_records

def save_day(conn, day, records, source, status="ok", note="", raw_path=None):
    """Validate an entire day before writing it; a failed fetch cannot erase a valid day."""
    if status not in {"ok", "empty", "failed", "unknown"}:
        raise ValueError("不支持的数据覆盖状态")
    if status != "ok" and records:
        raise ValueError("未确认日期的数据不能写入涨停档案")
    clean = validated_records(day, records, source)
    keys = ["date", "code", "name", "market", "industry", "boards", "close", "pct_change",
            "turnover", "first_time", "last_time", "open_times", "limit_up_reason", "source"]
    with transaction(conn):
        previous = conn.execute("SELECT status FROM days WHERE date=?", (day,)).fetchone()
        if status != "ok" and previous and previous["status"] == "ok":
            return False
        # The input is a full validated daily snapshot, so replace that day's facts atomically.
        # This changes database rows only; no filesystem paths are deleted.
        if status == "ok":
            conn.execute("DELETE FROM events WHERE date=?", (day,))
        for row in clean:
            conn.execute("INSERT INTO events (" + ",".join(keys) + ") VALUES (" + ",".join("?" for _ in keys) + ") "
                         "ON CONFLICT(date,code) DO UPDATE SET " + ",".join(f"{k}=excluded.{k}" for k in keys[2:]),
                         tuple(row.get(k) for k in keys))
            conn.execute("INSERT INTO stocks VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET "
                         "name=CASE WHEN excluded.last_seen >= stocks.last_seen THEN excluded.name ELSE stocks.name END, "
                         "market=excluded.market, last_seen=MAX(stocks.last_seen,excluded.last_seen)",
                         (row["code"], row["name"], row["market"], day))
        conn.execute("INSERT INTO days VALUES (?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
                     "status=excluded.status, source=excluded.source, note=excluded.note, "
                     "count=excluded.count, fetched_at=excluded.fetched_at, raw_path=excluded.raw_path",
                     (day, status, source, note, len(clean), now_iso(), raw_path))
    return True
