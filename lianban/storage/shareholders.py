"""Atomic replacement of complete, non-regressing shareholder snapshots."""
from lianban.core.clock import now_iso
from lianban.core.shareholders import SOURCE
from lianban.storage.transaction import transaction


def save_batch(conn, codes, records_by_scope):
    fetched_at = now_iso()
    # Both scopes of a batch are fetched before replacing any cached profiles.
    with transaction(conn):
        for scope, records in records_by_scope.items():
            latest = {}
            for row in records:
                latest[row["code"]] = max(latest.get(row["code"], ""), row["report_date"])
            for code in codes:
                old = conn.execute("SELECT report_date FROM shareholder_profiles WHERE code=? AND scope=?", (code, scope)).fetchone()
                if old and old[0] and (code not in latest or latest[code] < old[0]):
                    raise ValueError(f"{code} 股东资料缺失或倒退，保留缓存")
                conn.execute("DELETE FROM stock_shareholders WHERE code=? AND scope=?", (code, scope))
                conn.execute("INSERT INTO shareholder_profiles(code,scope,report_date,source,fetched_at,ratio_checked) VALUES (?,?,?,?,?,1) ON CONFLICT(code,scope) DO UPDATE SET "
                             "report_date=excluded.report_date,source=excluded.source,fetched_at=excluded.fetched_at,ratio_checked=1",
                             (code, scope, latest.get(code), SOURCE, fetched_at))
            conn.executemany("INSERT OR IGNORE INTO stock_shareholders(code,scope,holder_key,holder_name,holder_type,report_date,holding_ratio) VALUES (?,?,?,?,?,?,?)",
                [(r["code"], scope, r["holder_key"], r["holder_name"], r["holder_type"], r["report_date"], r.get("holding_ratio"))
                 for r in records if r["report_date"] == latest[r["code"]]])
