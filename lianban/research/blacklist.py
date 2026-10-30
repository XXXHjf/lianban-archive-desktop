from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from lianban.readside.stock_profiles import enrich_stock_profiles
from lianban.core.stock import is_st_name

def get_blacklist(conn):
    rows = [dict(row) for row in conn.execute(
        "SELECT b.code,s.name,s.market,b.created_at FROM stock_blacklist b "
        "JOIN stocks s ON s.code=b.code ORDER BY b.created_at DESC,b.code") if not is_st_name(row["name"])]
    for offset in range(0, len(rows), 500):
        enrich_stock_profiles(conn, rows[offset:offset + 500])
    return {"rows": rows, "total": len(rows)}


def save_blacklist(conn, code, action):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    if action not in ("add", "remove"):
        raise ValueError("黑名单操作应为 add 或 remove")
    if conn.execute("SELECT 1 FROM stocks WHERE code=?", (code,)).fetchone() is None:
        raise ValueError("这只股票尚未收录，请从搜索结果中选择")
    with transaction(conn):
        if action == "add":
            cursor = conn.execute("INSERT INTO stock_blacklist(code,created_at) VALUES (?,?) "
                                  "ON CONFLICT(code) DO NOTHING", (code, now_iso()))
        else:
            cursor = conn.execute("DELETE FROM stock_blacklist WHERE code=?", (code,))
    return {**get_blacklist(conn), "code": code, "action": action, "changed": cursor.rowcount == 1}
