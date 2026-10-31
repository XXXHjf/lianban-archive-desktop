"""Latest disclosed top-ten holders, indexed by full disclosed name."""
from __future__ import annotations

from contextlib import closing
from datetime import date, datetime, timedelta
import gzip
import json
import math
import re
from pathlib import Path
import ssl
import time
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from lianban.config import DEFAULT_DB
from lianban.core.clock import TZ, now_iso
from lianban.core.shareholders import SOURCE, URL, REPORTS, SCOPE_NOTE, BATCH_SIZE
from lianban.storage import connect, initialize
from lianban.storage.settings import set_settings
from lianban.storage.shareholders import save_batch
from lianban.runtime.metadata import MetadataRefresher
from lianban.profiles.registration import secucode


def normalize_rows(payload, requested, today, scope="total"):
    if (isinstance(payload, dict) and payload.get("success") is False
            and payload.get("code") == 9201 and payload.get("message") == "返回数据为空"):
        return [], 0, 0
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise ValueError("股东来源返回格式异常")
    pages, count = result.get("pages"), result.get("count")
    if type(pages) is not int or type(count) is not int or pages < 1 or count < 1 or not result["data"]:
        raise ValueError("股东来源分页信息异常")
    records = []
    for row in result["data"]:
        code = row.get("SECURITY_CODE")
        if code not in requested or row.get("SECUCODE") != secucode(code):
            raise ValueError("股东来源证券代码不匹配")
        report_date = date.fromisoformat(str(row.get("END_DATE", ""))[:10]).isoformat()
        notice = row.get("NOTICE_DATE")
        if report_date > today or (notice and date.fromisoformat(str(notice)[:10]).isoformat() > today):
            raise ValueError("股东来源包含尚未披露的未来资料")
        name = row.get("HOLDER_NAME")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("股东名称无效")
        name = name.strip()
        key = " ".join(unicodedata.normalize("NFKC", name).split()).casefold()
        ratio_field = "HOLD_RATIO" if scope == "total" else "FREE_HOLDNUM_RATIO"
        if ratio_field not in row:
            raise ValueError("股东来源持股比例字段缺失")
        ratio = row[ratio_field]
        if ratio is not None:
            if isinstance(ratio, bool):
                raise ValueError("股东持股比例无效")
            ratio = float(ratio)
            if not math.isfinite(ratio) or not 0 <= ratio <= 100:
                raise ValueError("股东持股比例无效")
        records.append({"code": code, "holder_name": name, "holder_key": key,
                        "holder_type": row.get("HOLDER_NEWTYPE") or "未分类", "report_date": report_date,
                        "holding_ratio": ratio})
    return records, pages, count


def fetch_batch(codes, scope, raw_dir):
    import truststore

    quoted = ",".join(f'"{secucode(code)}"' for code in codes)
    today = datetime.now(TZ).date().isoformat()
    eligible = f"(END_DATE<='{today}')"
    fields = "SECUCODE,SECURITY_CODE,END_DATE,HOLDER_NAME,HOLDER_NEWTYPE,NOTICE_DATE"
    fields += ",HOLD_RATIO" if scope == "total" else ",FREE_HOLDNUM_RATIO"
    params = {"reportName": REPORTS[scope], "columns": fields,
              "filter": f'(SECUCODE in ({quoted}))(IS_MAX_REPORTDATE="1")' + eligible,
              "pageSize": 1000, "sortColumns": "SECUCODE,END_DATE,HOLDER_NAME", "sortTypes": "1,-1,1",
              "source": "HSF10", "client": "PC"}
    page, pages, count, records, payloads = 1, 1, None, [], []
    while page <= pages:
        params["pageNumber"] = page
        request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/"})
        time.sleep(0.3)
        with urlopen(request, timeout=20, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
            payload = json.load(response)
        rows, total_pages, total_count = normalize_rows(payload, set(codes), today, scope)
        if count is not None and (total_pages != pages or total_count != count):
            raise ValueError("股东来源分页发生变化，稍后重试")
        pages, count = total_pages, total_count
        records.extend(rows)
        payloads.append(payload)
        page += 1
    if len(records) != count:
        raise ValueError("股东来源分页未完整返回")
    # A real source case (300327, 2026-10-29) marks a future allotment as
    # latest. Recover the most recent eligible snapshot for missing codes.
    for code in sorted(set(codes) - {r["code"] for r in records}):
        params.update(filter=f'(SECUCODE="{secucode(code)}")' + eligible,
                      pageNumber=1, pageSize=100, sortColumns="END_DATE,HOLDER_NAME", sortTypes="-1,1")
        request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/"})
        time.sleep(0.3)
        with urlopen(request, timeout=20, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
            payload = json.load(response)
        rows, _, total = normalize_rows(payload, {code}, today, scope)
        if rows and total > len(rows) and rows[-1]["report_date"] == rows[0]["report_date"]:
            raise ValueError("最新股东快照未完整返回")
        if rows:
            records.extend(r for r in rows if r["report_date"] == rows[0]["report_date"])
        payloads.append(payload)
    raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(TZ).strftime("%Y%m%dT%H%M%S%f")
    with gzip.open(raw_dir / f"{scope}_{codes[0]}_{stamp}.json.gz", "wt", encoding="utf-8") as output:
        json.dump(payloads, output, ensure_ascii=False)
    return records


def refresh(path=DEFAULT_DB):
    cutoff = (datetime.now(TZ) - timedelta(hours=24)).isoformat(timespec="seconds")
    with closing(initialize(path)) as conn:
        codes = [r[0] for r in conn.execute("SELECT s.code FROM stocks s LEFT JOIN shareholder_profiles p ON p.code=s.code "
                "GROUP BY s.code HAVING COUNT(p.scope)<2 OR MIN(p.fetched_at)<? OR MIN(p.ratio_checked)=0 ORDER BY s.code", (cutoff,))]
        requested = conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0]
        set_settings(conn, shareholder_status="updating", shareholder_completed=0, shareholder_pending=len(codes))
    for offset in range(0, len(codes), BATCH_SIZE):
        batch = codes[offset:offset + BATCH_SIZE]
        records = {scope: fetch_batch(batch, scope, Path(path).resolve().parent / "shareholders") for scope in REPORTS}
        with closing(connect(path)) as conn:
            save_batch(conn, batch, records)
            set_settings(conn, shareholder_completed=offset + len(batch), shareholder_pending=len(codes))
        if offset + BATCH_SIZE < len(codes):
            time.sleep(0.3)
    with closing(connect(path)) as conn:
        set_settings(conn, shareholder_fetched_at=now_iso(), shareholder_status="current",
                        shareholder_error=None, shareholder_requested=requested)
    return len(codes)


class Refresher(MetadataRefresher):
    def __init__(self, path):
        super().__init__(path, prefix="shareholder", refresh_callback=refresh)
