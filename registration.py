"""Current company registration provinces, fetched without detailed addresses."""
from __future__ import annotations

from contextlib import closing
import json
from pathlib import Path
import re
import ssl
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import database as db
from industry import Refresher as MetadataRefresher
from provinces import normalize_province

SOURCE = "东方财富 · 公司资料（注册省份）"
URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
FIELDS = "SECUCODE,SECURITY_CODE,REGIONBK"
BATCH_SIZE = 150


def secucode(code):
    if not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("注册省份请求中的股票代码无效")
    suffix = "SH" if code.startswith("6") else "BJ" if code.startswith(("4", "8", "92")) else "SZ"
    return f"{code}.{suffix}"


def province_only_snapshot(value):
    """Remove legacy address/location fields while preserving other snapshot evidence."""
    if isinstance(value, list):
        return [province_only_snapshot(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        lower = key.lower()
        if "address" in lower or lower in ("city", "location", "registered_city", "registered_location"):
            continue
        result[key] = normalize_province(item) if lower in ("province", "registered_province", "regionbk") else province_only_snapshot(item)
    return result


def clean_legacy_snapshots(path=db.DEFAULT_DB):
    changed = 0
    raw_dir = Path(path).resolve().parent / "raw"
    for snapshot in raw_dir.glob("registration_*.json"):
        if not snapshot.resolve().is_relative_to(raw_dir):
            raise ValueError("注册省份快照路径超出数据目录")
        payload = json.loads(snapshot.read_text(encoding="utf-8-sig"))
        clean = province_only_snapshot(payload)
        if clean != payload:
            snapshot.write_text(json.dumps(clean, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            changed += 1
    return changed


def normalize_batch(payload, requested):
    # The company-info endpoint explicitly reports unsupported historical
    # securities with this no-data response. Other failures remain errors.
    if (isinstance(payload, dict) and payload.get("success") is False and payload.get("code") == 9201
            and payload.get("result") is None and payload.get("message") == "返回数据为空"):
        return []
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise ValueError("注册省份来源返回格式异常")
    data = result["data"]
    if result.get("count") != len(data) or result.get("pages", 0) > 1:
        raise ValueError("注册省份来源分页未完整返回")
    seen, records = set(), []
    for row in data:
        code = row.get("SECURITY_CODE")
        if not isinstance(code, str) or code not in requested or row.get("SECUCODE") != secucode(code) or code in seen:
            raise ValueError("注册省份来源存在重复或不匹配的证券代码")
        seen.add(code)
        region = row.get("REGIONBK") or ""
        if not isinstance(region, str):
            raise ValueError("注册省份字段无效")
        province = normalize_province(region)
        if province:
            records.append({"code": code, "province": province})
    return records


def _fetch_batch(codes):
    import truststore

    quoted = ",".join(f'"{secucode(code)}"' for code in codes)
    params = {"reportName": "RPT_F10_ORG_BASICINFO", "columns": FIELDS,
              "filter": f"(SECUCODE in ({quoted}))", "pageNumber": 1, "pageSize": 500,
              "source": "HSF10", "client": "PC"}
    request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/"})
    with urlopen(request, timeout=15, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("注册省份来源响应过大")
    return normalize_batch(json.loads(raw), set(codes))


def refresh(path=db.DEFAULT_DB):
    clean_legacy_snapshots(path)
    with closing(db.connect(path)) as conn:
        codes = [row[0] for row in conn.execute("SELECT code FROM stocks ORDER BY code")]
    if not codes:
        return 0
    records = []
    for offset in range(0, len(codes), BATCH_SIZE):
        records.extend(_fetch_batch(codes[offset:offset + BATCH_SIZE]))
        if offset + BATCH_SIZE < len(codes):
            time.sleep(0.3)
    if len(records) < len(codes) * 0.8:
        raise ValueError("注册省份返回数量异常，保留原缓存")
    with closing(db.connect(path)) as conn:
        db.save_registrations(conn, records, SOURCE, db.now_iso(), [], len(codes))
    return len(records)


class Refresher(MetadataRefresher):
    def __init__(self, path):
        clean_legacy_snapshots(path)
        super().__init__(path, prefix="registration", refresh_callback=refresh)


if __name__ == "__main__":
    print(f"Updated {refresh()} company registration provinces.")
