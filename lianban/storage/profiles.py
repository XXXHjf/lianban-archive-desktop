from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from lianban.core.province import normalize_province

def bump_suspension_revision(conn):
    conn.execute("INSERT INTO settings VALUES ('suspension_revision','1') ON CONFLICT(key) "
                 "DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)")


def save_suspensions(conn, day, records, source, raw_paths):
    now = now_iso()
    with transaction(conn):
        conn.execute("DELETE FROM suspension_records WHERE date=?", (day,))
        for row in records:
            conn.execute("INSERT INTO suspension_records VALUES (?,?,?,?,?,?,?,?)",
                         (day, row["code"], row["name"], row["start"], row["end"], row["resume"], row["reason"], int(row["full_day"])))
        conn.execute("INSERT INTO suspension_days VALUES (?,'ok',?,?,?,?,NULL) ON CONFLICT(date) DO UPDATE SET "
                     "status='ok',checked_at=excluded.checked_at,fetched_at=excluded.fetched_at,source=excluded.source,"
                     "raw_paths=excluded.raw_paths,error=NULL", (day, now, now, source, json.dumps(raw_paths)))
        bump_suspension_revision(conn)


def save_industries(conn, records, source, fetched_at, raw_paths):
    """Commit a fully validated industry snapshot without editing event facts."""
    with transaction(conn):
        for row in records:
            conn.execute("INSERT INTO stock_industries VALUES (?,?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(code) DO UPDATE SET industry=excluded.industry, "
                         "industry_level2=excluded.industry_level2, industry_level3=excluded.industry_level3, "
                         "industry_code=excluded.industry_code, effective_from=excluded.effective_from, "
                         "source_updated_at=excluded.source_updated_at, source=excluded.source, fetched_at=excluded.fetched_at",
                         (row["code"], row["industry"], row["industry_level2"], row["industry_level3"],
                          row["industry_code"], row["effective_from"], row["source_updated_at"], source, fetched_at))
        values = {"industry_status": "ok", "industry_source": source, "industry_fetched_at": fetched_at,
                  "industry_count": len(records), "industry_raw_paths": raw_paths, "industry_error": None}
        for key, value in values.items():
            conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (key, json.dumps(value, ensure_ascii=False)))


def save_registrations(conn, records, source, fetched_at, raw_paths, requested_count):
    with transaction(conn):
        for row in records:
            province = normalize_province(row["province"])
            if not province:
                raise ValueError("注册省份无效")
            # Retain empty legacy columns for compatibility with existing archive copies.
            conn.execute("INSERT INTO company_registrations VALUES (?,?,?,?,?,?,?) "
                         "ON CONFLICT(code) DO UPDATE SET province=excluded.province, city=excluded.city, "
                         "location=excluded.location, address=excluded.address, source=excluded.source, fetched_at=excluded.fetched_at",
                         (row["code"], province, "", "", "", source, fetched_at))
        values = {"registration_status": "ok", "registration_source": source,
                  "registration_fetched_at": fetched_at, "registration_count": len(records),
                  "registration_requested": requested_count, "registration_raw_paths": [],
                  "registration_error": None}
        for key, value in values.items():
            conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (key, json.dumps(value, ensure_ascii=False)))
