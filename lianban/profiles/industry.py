"""Refresh a separately attributed, current Shenwan industry snapshot.

Historical limit-up facts are never rewritten with current classifications.
Only two public reference files are requested per refresh; failed updates keep
the last validated cache. No account, API token or scheduled OS task is needed.
"""
from __future__ import annotations

from contextlib import closing
from datetime import date, datetime, timedelta
import hashlib
from pathlib import Path
import re
import ssl
import threading
import time
from urllib.request import Request, urlopen

from lianban.config import DEFAULT_DB, ROOT
from lianban.core.clock import TZ, now_iso
from lianban.storage import connect, initialize
from lianban.storage.profiles import save_industries

SOURCE = "申万宏源研究 · 申万2021行业分类"
BASE_URL = "https://www.swsresearch.com/swindex/pdf/SwClass2021/"
STOCK_URL = BASE_URL + "StockClassifyUse_stock.xls"
DICTIONARY_URL = BASE_URL + "SwClassCode_2021.xls"
INTERMEDIATE_CA = ROOT / "certs" / "geotrust-g2-cn-2022-ca1.crt"
MAX_AGE = timedelta(hours=24)


def _download(url):
    import truststore

    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.swsresearch.com/"})
    # The upstream omits its intermediate. Windows can fetch it automatically,
    # whereas OpenSSL needs the verified issuer supplied alongside system roots.
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(INTERMEDIATE_CA))
    # Require a chain to an existing trusted root; the issuer is not a new root.
    context.verify_flags &= ~ssl.VERIFY_X509_PARTIAL_CHAIN
    with urlopen(request, timeout=15, context=context) as response:
        payload = response.read(8 * 1024 * 1024 + 1)
    if not payload.startswith(b"\xd0\xcf\x11\xe0") or len(payload) > 8 * 1024 * 1024:
        raise ValueError("行业源没有返回有效的 XLS 文件")
    return payload


def select_current(rows, dictionary, today):
    """Select the latest effective assignment; never borrow a future record."""
    latest = {}
    for code, start, industry_code, updated in rows:
        if not re.fullmatch(r"[0-9]{6}", code) or not re.fullmatch(r"[0-9]{6}", industry_code):
            raise ValueError("行业源股票代码或行业代码无效")
        date.fromisoformat(start)
        date.fromisoformat(updated)
        if start > today:
            continue
        item = (start, updated, industry_code)
        previous = latest.get(code)
        if previous and previous[:2] == item[:2] and previous[2] != industry_code:
            raise ValueError("行业源存在同日冲突分类")
        if previous is None or item[:2] > previous[:2]:
            latest[code] = item
    result = []
    for code, (start, updated, industry_code) in latest.items():
        names = dictionary.get(industry_code)
        # Retired 2014 codes cannot be translated using a different taxonomy.
        if not names:
            continue
        result.append({"code": code, "industry": names[0], "industry_level2": names[1],
                       "industry_level3": names[2], "industry_code": industry_code,
                       "effective_from": start, "source_updated_at": updated})
    return result


def parse_files(stock_bytes, dictionary_bytes):
    import xlrd  # Optional for an offline UI; installed through requirements.txt.

    dictionary_sheet = xlrd.open_workbook(file_contents=dictionary_bytes).sheet_by_index(0)
    if dictionary_sheet.row_values(0) != ["行业代码", "一级行业名称", "二级行业名称", "三级行业名称"]:
        raise ValueError("行业名称字典结构发生变化")
    dictionary = {}
    for index in range(1, dictionary_sheet.nrows):
        code, *names = [str(value).strip() for value in dictionary_sheet.row_values(index)]
        if not re.fullmatch(r"[0-9]{6}", code) or not names[0] or code in dictionary:
            raise ValueError("行业名称字典存在无效或重复记录")
        dictionary[code] = names

    workbook = xlrd.open_workbook(file_contents=stock_bytes)
    sheet = workbook.sheet_by_index(0)
    if sheet.row_values(0) != ["股票代码", "计入日期", "行业代码", "更新日期"]:
        raise ValueError("股票行业分类结构发生变化")

    def iso_day(value):
        if isinstance(value, (float, int)):
            return xlrd.xldate_as_datetime(value, workbook.datemode).date().isoformat()
        return date.fromisoformat(str(value).strip()[:10]).isoformat()

    rows = []
    for index in range(1, sheet.nrows):
        code, start, industry_code, updated = sheet.row_values(index)
        rows.append((str(code).strip(), iso_day(start), str(industry_code).strip(), iso_day(updated)))
    result = select_current(rows, dictionary, datetime.now(TZ).date().isoformat())
    if len(result) < 3000:
        raise ValueError("行业数据数量异常，保留原缓存")
    return result


def refresh(path=DEFAULT_DB):
    stock_bytes, dictionary_bytes = _download(STOCK_URL), _download(DICTIONARY_URL)
    records = parse_files(stock_bytes, dictionary_bytes)
    fetched_at = now_iso()
    raw_dir = Path(path).resolve().parent / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(TZ).strftime("%Y%m%dT%H%M%S%f")
    raw_paths = []
    for label, payload in (("stocks", stock_bytes), ("dictionary", dictionary_bytes)):
        digest = hashlib.sha256(payload).hexdigest()[:12]
        raw_path = raw_dir / f"industry_{label}_{stamp}_{digest}.xls"
        raw_path.write_bytes(payload)
        raw_paths.append(str(raw_path))
    with closing(connect(path)) as conn:
        save_industries(conn, records, SOURCE, fetched_at, raw_paths)
    return len(records)


from lianban.runtime.metadata import MetadataRefresher


class Refresher(MetadataRefresher):
    def __init__(self, path):
        super().__init__(path, prefix="industry", refresh_callback=refresh)


if __name__ == "__main__":
    with closing(initialize(DEFAULT_DB)):
        pass
    print(f"Updated {refresh()} current industry classifications.")
