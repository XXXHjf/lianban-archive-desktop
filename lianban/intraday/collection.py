"""Explicit per-stock collection use case, separate from read-only views."""
from contextlib import closing
import json
from pathlib import Path
import threading
from lianban.core.clock import now_iso
from . import api as intraday
from .network import fetch_json
from .normalizers import tencent_reference, normalize_auction
from .catalog import save_catalog, sync_catalog

AUCTION_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_Bill.GetBillList"
_lock = threading.Lock()
_stock_locks = {}
_workers = threading.BoundedSemaphore(4)

def collect_requested(archive_path, day, code, *, force=False):
    detail = intraday.stock_view(archive_path, day, code, include_live=True)  # validates date, code and membership
    key = (str(Path(archive_path).resolve()), code)
    with _lock:
        stock_lock = _stock_locks.setdefault(key, threading.Lock())
    with stock_lock, _workers:
        detail = intraday.stock_view(archive_path, day, code, include_live=True)
        raw_dir = Path(archive_path).resolve().parent / "intraday_raw"
        symbol = ("sh" if code.startswith("6") else "sz") + code
        if not detail["points"] or detail["needs_refresh"] or (force and detail["status"] != "ok"):
            try:
                payload, raw_path = fetch_json(intraday.TENCENT_URL, {"code": symbol}, raw_dir, f"mainboard_{code}")
                event = dict(detail["stock"])
                points = intraday.normalize_tencent(payload, event)
                if not event.get("close"):
                    event["previous_close"], event["reference_basis"] = tencent_reference(payload, symbol, day)
                with closing(intraday.initialize(intraday.store_path(archive_path))) as conn:
                    intraday.save_session(conn, event, points, "腾讯财经分时", raw_path)
            except Exception as exc:
                with closing(intraday.initialize(intraday.store_path(archive_path))) as conn:
                    intraday.save_error(conn, day, code, f"按需采集失败：{type(exc).__name__}: {str(exc)[:160]}")
            detail = intraday.stock_view(archive_path, day, code, include_live=True)
        if detail["points"] and (force or detail["auction"]["status"] == "unchecked"):
            source, raw_path, points = "新浪财经 09:25 撮合记录", "", []
            try:
                payload, raw_path = fetch_json(AUCTION_URL, {"symbol": symbol, "num": 60, "page": 1, "sort": "ticktime", "asc": 1, "volume": 0, "amount": 0, "type": 0, "day": day}, raw_dir, f"auction_{day}_{code}")
                points = normalize_auction(payload, symbol, detail["points"])
                note = "仅含 09:25 实际撮合价量；09:15—09:24 虚拟匹配走势未取得。竞价量从 09:30 累计首柱扣除，避免重复。" if points else "来源未返回该日 09:25 撮合记录；未用 09:30 数据代替。"
            except Exception as exc:
                note = f"竞价暂不可用：{type(exc).__name__}；未用 09:30 数据代替。"
            with closing(intraday.initialize(intraday.store_path(archive_path))) as conn, conn:
                previous = conn.execute("SELECT status FROM auctions WHERE date=? AND code=?", (day, code)).fetchone()
                if points or not previous or previous[0] != "match_only":
                    conn.execute("INSERT OR REPLACE INTO auctions VALUES (?,?,?,?,?,?,?,?)", (day, code, "match_only" if points else "unavailable", json.dumps(points, ensure_ascii=False, allow_nan=False), note, source, now_iso(), raw_path))
        return intraday.stock_view(archive_path, day, code, include_live=True)
