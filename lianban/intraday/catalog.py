"""Mainboard catalog synchronization; independent of tag defaults."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import re
from lianban.core.clock import TZ, now_iso
from lianban.core.stock import market_for
from lianban.storage import connect
from . import api as intraday

def save_catalog(archive_path, records, total, source="主板目录"):
    if len(records) != total or len({r["code"] for r in records}) != total:
        raise ValueError("主板目录分页缺失或重复，保留原目录")
    if any(not intraday.is_mainboard(r["code"]) or not r["name"].strip() for r in records):
        raise ValueError("主板目录包含非主板股票或无效名称")
    stamp = now_iso()
    with closing(intraday.initialize(intraday.store_path(archive_path))) as conn, conn:
        conn.execute("CREATE TEMP TABLE incoming_codes (code TEXT PRIMARY KEY)")
        conn.executemany("INSERT INTO incoming_codes VALUES (?)", [(r["code"],) for r in records])
        conn.executemany("INSERT INTO universe VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,market=excluded.market,source=excluded.source,fetched_at=excluded.fetched_at",
                         [(r["code"], r["name"], market_for(r["code"]), source, stamp) for r in records])
        # This removes stale database rows only, never files or historical sessions.
        conn.execute("DELETE FROM universe WHERE code NOT IN (SELECT code FROM incoming_codes)")
        conn.execute("INSERT OR REPLACE INTO universe_meta VALUES ('snapshot',?)", (json.dumps({"total": total, "fetched_at": stamp}),))
    with closing(connect(archive_path)) as conn, conn:
        conn.executemany("INSERT OR IGNORE INTO stocks VALUES (?,?,?,?)", [(r["code"], r["name"], market_for(r["code"]), stamp[:10]) for r in records])
    return {"total": total, "fetched_at": stamp}


def sync_catalog(archive_path):
    """Query every legal 00/60 code slot; keep only provider-identified A shares.

    A bounded quote request avoids incomplete directory pagination. Every batch
    is retained so the exact requested ranges and returned symbols are auditable.
    """
    import requests
    raw = Path(archive_path).resolve().parent / "intraday_raw"
    raw.mkdir(parents=True, exist_ok=True)
    symbols = [f"sz{n:06}" for n in range(10000)] + [f"sh{n:06}" for n in range(600000, 610000)]
    batches = [symbols[i:i + 500] for i in range(0, len(symbols), 500)]
    def batch(items):
        for attempt in range(2):
            try:
                response = requests.get("https://qt.gtimg.cn/q=" + ",".join(items), timeout=(4, 12))
                response.raise_for_status()
                response.encoding = "gbk"
                if not response.text.lstrip().startswith("v_"):
                    raise ValueError("主板行情目录响应不是证券报价")
                break
            except requests.RequestException:
                if attempt:
                    raise
        (raw / f"quote_catalog_{items[0]}_{datetime.now(TZ):%Y%m%dT%H%M%S}.txt").write_text(response.text, encoding="utf-8")
        result = []
        for symbol, body in re.findall(r'v_((?:sz|sh)\d{6})="([^"]*)"', response.text):
            cells = body.split("~")
            if symbol not in items or len(cells) < 31 or cells[2] != symbol[2:]:
                raise ValueError("行情目录代码与请求不一致")
            if "GP-A" in cells and not cells[1].endswith("退") and not cells[1].startswith("退市"):
                result.append({"code": cells[2], "name": cells[1]})
        return result
    with ThreadPoolExecutor(max_workers=3) as pool:
        records = [row for group in pool.map(batch, batches) for row in group]
    if not 3000 <= len(records) <= 5000:
        raise ValueError("全号段行情目录数量异常，未覆盖本地目录")
    return save_catalog(archive_path, records, len(records), "腾讯沪深主板行情目录（00/60 全号段核验）")
