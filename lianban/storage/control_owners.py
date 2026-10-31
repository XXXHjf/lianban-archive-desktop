"""Atomic replacement of current display-only control profiles."""
from lianban.core.clock import now_iso
from lianban.storage.transaction import transaction

SOURCE = "东方财富 · 公司资料（控股股东及实际控制人）"


def save_batch(conn, codes, records, available_codes):
    requested = set(codes)
    if not set(available_codes) <= requested or any(
            row["code"] not in available_codes or row["kind"] not in ("controller", "actual_controller")
            for row in records):
        raise ValueError("控股资料批次包含无效主体或证券")
    fetched_at = now_iso()
    with transaction(conn):
        for code in codes:
            old = conn.execute("SELECT source FROM stock_control_profiles WHERE code=?", (code,)).fetchone()
            if old and old[0] and code not in available_codes:
                raise ValueError(f"{code} 控股资料缺失，保留缓存")
            conn.execute("DELETE FROM stock_control_owners WHERE code=?", (code,))
            conn.execute("INSERT INTO stock_control_profiles VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET "
                         "source=excluded.source,fetched_at=excluded.fetched_at",
                         (code, SOURCE if code in available_codes else "", fetched_at))
        conn.executemany("INSERT OR IGNORE INTO stock_control_owners VALUES (?,?,?,?,?,?,?,?)",
                         [(r["code"], r["kind"], r["holder_key"], r["holder_name"], r["holder_type"], r["via_name"],
                           r["source_url"], fetched_at) for r in records])
