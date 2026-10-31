"""Atomic subsidiary cache updates, preserving successful data on errors."""
import json

from lianban.storage.transaction import transaction


def save_error(conn, code, attempted_at, error):
    with transaction(conn):
        conn.execute("INSERT INTO subsidiary_profiles(code,attempted_at,error) VALUES (?,?,?) "
                     "ON CONFLICT(code) DO UPDATE SET attempted_at=excluded.attempted_at,error=excluded.error",
                     (code, attempted_at, error))


def save_profile(conn, code, disclosure_date, companies, stamp):
    with transaction(conn):
        old = conn.execute("SELECT disclosure_date,fetched_at FROM subsidiary_profiles WHERE code=?", (code,)).fetchone()
        if old and old["disclosure_date"] and (not disclosure_date or disclosure_date < old["disclosure_date"]):
            raise ValueError("子公司资料公告日期倒退，保留缓存")
        if old and old["fetched_at"] and stamp < old["fetched_at"]:
            raise ValueError("子公司资料请求时间倒退，保留缓存")
        conn.execute("INSERT INTO subsidiary_profiles "
                     "(code,disclosure_date,companies_json,source_url,fetched_at,attempted_at,error) "
                     "VALUES (?,?,?,?,?,?,'') ON CONFLICT(code) DO UPDATE SET "
                     "disclosure_date=excluded.disclosure_date,companies_json=excluded.companies_json,"
                     "source_url=excluded.source_url,fetched_at=excluded.fetched_at,attempted_at=excluded.attempted_at,error=''",
                     (code, disclosure_date, json.dumps(companies, ensure_ascii=False),
                      f"https://basic.10jqka.com.cn/{code}/company.html", stamp, stamp))
