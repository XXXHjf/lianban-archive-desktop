"""Current default tags: the intersection of THS concepts and CLS plates.

Only validated, matching securities contribute defaults. User overrides are
never written here. Per-source snapshots make large refreshes resumable.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing, contextmanager
from datetime import datetime, timedelta
import gzip
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import threading
import time
import unicodedata

import requests

from lianban.config import DEFAULT_DB
from lianban.core.clock import TZ, now_iso
from lianban.storage import connect, initialize
from lianban.storage.settings import set_settings
from lianban.research.tags import save_default_tags
from lianban.runtime.metadata import MetadataRefresher
from lianban.core.province import normalize_province

SOURCE = "同花顺概念 ∩ 财联社板块"
CACHE_AGE = timedelta(days=7)
THS_URL = "https://basic.10jqka.com.cn/{code}/concept.html"
CLS_URL = "https://x-quote.cls.cn/v2/quote/a/web/stock/detail"
# Only spelling / equivalent names, never fuzzy or broader topic matching.
ALIASES = {"5g产业链": "5G", "5g": "5G", "ipv6": "IPv6"}
STYLE_TAGS = {"昨日涨停", "昨日连板", "昨日首板", "昨日炸板", "昨日大额成交", "百日新高",
              "近期新高", "历史新高", "百元股", "破净股", "低市盈率", "高市盈率", "高股息",
              "高ROE", "大盘股", "中盘股", "小盘股", "行业龙头", "融资融券", "沪股通", "深股通"}
_local = threading.local()
_pace_lock = threading.Lock()
_next_request = {}
_interval = {"ths": 1.0, "cls": 0.2}
_denial_streak = {"ths": 0, "cls": 0}


class SourceUnavailable(ValueError):
    """The source explicitly has no concept profile for this security."""


class SourceRestricted(RuntimeError):
    """Pause this upstream after bounded, delayed retries of its own URL."""


class ConceptParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = []
        self.in_title = False
        self.cell = None
        self.tags = []
        self.has_table = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "table" and "gnContent" in attrs.get("class", "").split():
            self.has_table = True
        if tag == "td" and {"gnName", "gnStockList"}.intersection(attrs.get("class", "").split()):
            self.cell = []

    def handle_data(self, value):
        if self.in_title:
            self.title.append(value)
        if self.cell is not None:
            self.cell.append(value)

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag == "td" and self.cell is not None:
            self.tags.append("".join(self.cell).strip())
            self.cell = None


def validate_tags(tags):
    if not isinstance(tags, list) or len(tags) > 300:
        raise ValueError("概念标签列表结构异常")
    result = []
    for tag in tags:
        if not isinstance(tag, str) or not tag.strip() or len(tag) > 100 or any(ord(c) < 32 for c in tag.strip()):
            raise ValueError("概念标签内容异常")
        tag = tag.strip()
        if tag not in result:
            result.append(tag)
    return result


def parse_ths(raw, code):
    # The public F10 page declares GBK, independent of the HTTP default charset.
    text = raw.decode("utf-8-sig") if b"charset=utf-8" in raw[:4096].lower() else raw.decode("gb18030")
    parser = ConceptParser()
    parser.feed(text)
    title = "".join(parser.title)
    if f"({code})" not in title or "概念题材" not in title:
        raise ValueError("同花顺未返回该股票的概念页面")
    if not parser.has_table:
        raise SourceUnavailable("同花顺暂无概念列表")
    return validate_tags(parser.tags)


def symbol(code):
    prefix = "sh" if code.startswith("6") else "bj" if code.startswith(("4", "8", "92")) else "sz"
    return prefix + code


def parse_cls(payload, code):
    data = payload.get("data") if isinstance(payload, dict) and payload.get("code") == 200 else None
    if not isinstance(data, dict) or not isinstance(data.get("plate"), list):
        raise ValueError("财联社概念接口结构异常")
    quote = data.get("quote")
    if quote is None and not data["plate"]:
        raise SourceUnavailable("财联社暂无该股票资料")
    if not isinstance(quote, dict) or quote.get("secu_code") != symbol(code):
        raise ValueError("财联社返回的证券代码不匹配")
    return validate_tags([row.get("secu_name") if isinstance(row, dict) else None for row in data["plate"]])


def canonical_tag(tag):
    value = unicodedata.normalize("NFKC", tag).strip()
    value = re.sub(r"\s+", "", value)
    if value in STYLE_TAGS or value.startswith("昨日") or normalize_province(value) or re.fullmatch(r".+(?:本地|地区)", value):
        return None
    if value.endswith("概念"):
        value = value[:-2]
    return ALIASES.get(value.casefold(), value)


def common_tags(ths, cls):
    cls_keys = {tag.casefold() for raw in cls if (tag := canonical_tag(raw))}
    result, seen = [], set()
    for raw in ths:
        tag = canonical_tag(raw)
        if tag and tag.casefold() in cls_keys and tag.casefold() not in seen:
            result.append(tag)
            seen.add(tag.casefold())
    return result


def _session():
    if not hasattr(_local, "session"):
        _local.session = requests.Session()
        _local.session.headers.update({"User-Agent": "Mozilla/5.0"})
    return _local.session


def _get_once(source, code):
    # Pace each upstream separately even when multiple stocks are in flight.
    with _pace_lock:
        now = time.monotonic()
        start = max(now, _next_request.get(source, now))
        _next_request[source] = start + _interval[source]
    if start > now:
        time.sleep(start - now)
    if source == "ths":
        url, params, referer = THS_URL.format(code=code), None, "https://basic.10jqka.com.cn/"
    else:
        url, params, referer = CLS_URL, {"app": "CailianpressWeb", "os": "web", "sv": "8.7.9", "secu_code": symbol(code)}, "https://www.cls.cn/"
    with _session().get(url, params=params, headers={"Referer": referer}, timeout=(8, 15), stream=True) as response:
        if response.status_code == 404:
            raise SourceUnavailable(f"{source} 未收录该股票页面")
        response.raise_for_status()
        raw = bytearray()
        for chunk in response.iter_content(65536):
            raw.extend(chunk)
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError("概念来源响应过大")
    return bytes(raw)


def _get(source, code):
    for attempt in range(3):
        try:
            raw = _get_once(source, code)
            with _pace_lock:
                _denial_streak[source] = 0
            return raw
        except requests.HTTPError as exc:
            if exc.response is None or exc.response.status_code not in (403, 429):
                raise
            if attempt == 0:
                with _pace_lock:
                    _denial_streak[source] += 1
                    consecutive = _denial_streak[source]
                # One inaccessible security must not hide cached data or stop
                # unrelated securities. Repeated denials / any 429 pause the source.
                if exc.response.status_code == 403 and consecutive < 3:
                    raise
            if attempt == 2:
                raise SourceRestricted(f"{source} 暂时限制访问，保留进度，稍后重试") from exc
            retry_after = exc.response.headers.get("Retry-After", "")
            delay = max(60 * (attempt + 1), int(retry_after) if retry_after.isdigit() else 0)
            with _pace_lock:
                _interval[source] = min(2, _interval[source] * 2)
                _next_request[source] = max(_next_request.get(source, 0), time.monotonic() + delay)


def source_snapshot(root, source, code, force=False, stop=None):
    directory = root / source
    directory.mkdir(parents=True, exist_ok=True)
    cache = directory / f"{code}.json"
    if cache.exists() and not force:
        try:
            saved = json.loads(cache.read_text(encoding="utf-8"))
            if (saved.get("code") == code and saved.get("source") == source and saved.get("status") in ("ok", "unavailable")
                    and datetime.now(TZ) - datetime.fromisoformat(saved["fetched_at"]) < CACHE_AGE):
                validate_tags(saved["tags"])
                saved.setdefault("error", None)
                return saved
        except (ValueError, TypeError, KeyError, OSError):
            pass  # Replace an invalid local cache only after a successful fetch.
    if stop is not None and stop.is_set():
        raise SourceRestricted("来源限制访问，等待下一轮续传")
    raw = None
    try:
        raw = _get(source, code)
        tags = parse_ths(raw, code) if source == "ths" else parse_cls(json.loads(raw), code)
        status, error = "ok", None
    except SourceUnavailable as exc:
        tags, status, error = [], "unavailable", str(exc)
    saved = {"code": code, "source": source, "status": status, "tags": tags, "error": error, "fetched_at": now_iso()}
    # Keep source evidence on disk. A transient failure never overwrites a cache.
    if raw is not None:
        with gzip.open(directory / f"{code}.raw.gz", "wb") as output:
            output.write(raw)
    temp = cache.with_suffix(".json.tmp")
    temp.write_text(json.dumps(saved, ensure_ascii=False), encoding="utf-8")
    temp.replace(cache)
    return saved


def collect_stock(root, code, force=False, stop=None):
    if stop is not None and stop.is_set() and not (root / "cls" / f"{code}.json").exists():
        return {"code": code, "status": "deferred", "error": "来源限制访问，等待下一轮续传"}
    snapshots, errors = {}, []
    for source in ("cls", "ths"):
        if source == "ths" and snapshots.get("cls", {}).get("status") == "unavailable":
            snapshots["ths"] = {"tags": [], "status": "unavailable", "error": None,
                                "fetched_at": snapshots["cls"]["fetched_at"]}
            break
        try:
            snapshots[source] = source_snapshot(root, source, code, force, stop)
        except SourceRestricted as exc:
            if stop is not None:
                stop.set()
            return {"code": code, "status": "deferred", "error": str(exc)}
        except (requests.RequestException, ValueError, OSError) as exc:
            errors.append(f"{source}: {exc}")
    if errors:
        return {"code": code, "status": "error", "error": "; ".join(errors)}
    ths, cls = snapshots["ths"], snapshots["cls"]
    available = ths["status"] == cls["status"] == "ok"
    return {"code": code, "status": "ok" if available else "unavailable",
            "tags": common_tags(ths["tags"], cls["tags"]) if available else [],
            "ths_tags": ths["tags"], "cls_tags": cls["tags"],
            "fetched_at": min(ths["fetched_at"], cls["fetched_at"]),
            "reason": "; ".join(s["error"] for s in (ths, cls) if s["error"])}


@contextmanager
def refresh_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / "refresh.lock").open("a+b") as handle:
        handle.seek(0, 2)
        if not handle.tell():
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        acquired = False
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError:
            pass
        try:
            yield acquired
        finally:
            if acquired:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def refresh(path=DEFAULT_DB, *, force=False, workers=4, progress=None):
    root = Path(path).resolve().parent / "concept_tags"
    with refresh_lock(root) as acquired:
        if not acquired:
            return None
        with closing(connect(path)) as conn:
            codes = [r[0] for r in conn.execute("SELECT code FROM stocks ORDER BY last_seen DESC,code")]
            set_settings(conn, concept_status="updating", concept_requested=len(codes))
        report = {"source": SOURCE, "started_at": now_iso(), "requested": len(codes), "rows": []}
        batch = []
        stop = threading.Event()
        with ThreadPoolExecutor(max_workers=max(1, min(workers, 8))) as executor:
            jobs = {executor.submit(collect_stock, root, code, force, stop): code for code in codes}
            for future in as_completed(jobs):
                row = future.result()
                report["rows"].append(row)
                if row["status"] in ("ok", "unavailable"):
                    batch.append(row)
                done = len(report["rows"])
                if done % 50 == 0 or done == len(codes):
                    with closing(connect(path)) as conn:
                        save_default_tags(conn, batch, SOURCE)
                        set_settings(conn, concept_completed=done)
                    batch.clear()
                    report_path = root / "last-report.json"
                    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                    if progress:
                        progress(done, len(codes))
        errors = sum(r["status"] in ("error", "deferred") for r in report["rows"])
        with closing(connect(path)) as conn:
            saved_defaults = [json.loads(r[0]) for r in conn.execute(
                "SELECT tags_json FROM stock_default_tags WHERE code IN (SELECT code FROM stocks)")]
        report.update(finished_at=now_iso(), errors=errors, resolved=len(saved_defaults),
                      unavailable=sum(r["status"] == "unavailable" for r in report["rows"]),
                      tagged=sum(bool(tags) for tags in saved_defaults))
        (root / "last-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        with closing(connect(path)) as conn:
            set_settings(conn, default_tag_mode="concept_intersection", concept_source=SOURCE,
                            concept_status="partial" if errors else "ok", concept_fetched_at=now_iso(),
                            concept_errors=errors, concept_tagged=report["tagged"], concept_unavailable=report["unavailable"])
        return report


class Refresher(MetadataRefresher):
    def __init__(self, path):
        super().__init__(path, prefix="concept", refresh_callback=refresh)


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="补充同花顺和财联社共有概念，保留全部自定义标签")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--force", action="store_true", help="重新抓取七天内的有效快照")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    with closing(initialize(args.db)):
        pass
    report = refresh(args.db, force=args.force, workers=args.workers,
                     progress=lambda done, total: print(f"概念标签进度 {done}/{total}", flush=True))
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, ensure_ascii=False) if report else "另一轮概念更新正在运行。", flush=True)
