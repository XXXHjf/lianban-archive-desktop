"""Read-only public pool provider with date and schema validation."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
import hashlib
import json
import math
import re
import time

import requests

from database import market_for

TZ = timezone(timedelta(hours=8))
SOURCE = "选股宝公开涨停池"
CLS_SOURCE = "财联社公开涨停池"
SUMMARY_SOURCE = "选股宝历史池 / 财联社当日池"
POOL_URL = "https://flash-api.xuangubao.cn/api/pool/detail"
CLS_POOL_URL = "https://x-quote.cls.cn/quote/index/up_down_analysis"
CALENDAR_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
CALENDAR_SOURCE = "腾讯上证指数日线日期（辅助筛选交易日）"
ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36"
_SESSION = requests.Session()
# User-approved exclusions apply only to these historical stock/date pairs and
# their known zero-valued defects. Corrected rows are accepted again.
IGNORED_HISTORY_ZERO_FIELDS = {
    ("2020-02-25", "000953"): ("limit_up_days", "first_limit_up", "last_limit_up"),
    ("2020-03-17", "000502"): ("limit_up_days", "first_limit_up", "last_limit_up"),
    ("2020-05-14", "000408"): ("limit_up_days", "first_limit_up", "last_limit_up"),
    ("2020-05-19", "000408"): ("limit_up_days", "first_limit_up", "last_limit_up"),
    ("2020-05-19", "000615"): ("first_limit_up",),
}
SCOPE_NOTE = (
    "历史数据来自选股宝公开涨停池，当天优先采用财联社公开涨停池，展示范围以原始池实际收录为准；"
    "该来源并非交易所全量认证，未收录不等于未涨停。"
    "连板数直接采用来源 limit_up_days 字段；几天几板另属不同口径。"
)
METHOD_NOTE = (
    "首板记为 1，连板数采用所标注来源的 limit_up_days；"
    "选股宝记录的首次及末次封板日期、财联社记录的时间日期均须与请求日一致。"
    "财联社未提供的首次/末次封板时间、换手率及炸板次数留空。"
    "停牌与特殊阶段连续性沿用来源口径，未自行按涨幅推算。"
)


class ProviderError(RuntimeError):
    def __init__(self, message: str, raw_path: str | None = None):
        super().__init__(message)
        self.raw_path = raw_path


@dataclass
class DayResult:
    date: str
    records: list[dict]
    status: str
    note: str
    raw_path: str
    source: str = SOURCE


def valid_day(day: str) -> str:
    parsed = date.fromisoformat(day)
    if parsed.isoformat() != day:
        raise ValueError("日期必须为 YYYY-MM-DD")
    return day


def _get(url: str, params: dict, attempts: int = 3) -> requests.Response:
    last = None
    for attempt in range(attempts):
        try:
            response = _SESSION.get(url, params=params,
                                    headers={"User-Agent": UA, "Referer": "https://xuangubao.cn/"},
                                    timeout=(8, 20))
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(min(2 ** (attempt + 1), 8))
    raise ProviderError(f"公开接口请求失败（已尝试 {attempts} 次）：{last}")


def _save_raw(prefix: str, response: requests.Response, raw_dir: Path) -> str:
    raw_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(response.content).hexdigest()[:12]
    stamp = datetime.now(TZ).strftime("%Y%m%dT%H%M%S%f")
    path = raw_dir / f"{prefix}_{stamp}_{digest}.json"
    path.write_bytes(response.content)
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def _number(value, field: str, optional: bool = False) -> float | None:
    if value is None and optional:
        return None
    if isinstance(value, bool):
        raise ProviderError(f"{field} 不是有效数字")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ProviderError(f"{field} 不是有效数字") from None
    if not number.is_finite():
        raise ProviderError(f"{field} 不是有限数字")
    converted = float(number)
    if not math.isfinite(converted):
        raise ProviderError(f"{field} 超出可保存的有限数值范围")
    return converted


def _positive_integer(value, field: str) -> int:
    number = _number(value, field)
    if number < 1 or number != int(number) or number > 9223372036854775807:
        raise ProviderError(f"{field} 必须为正整数")
    return int(number)


def _time_on_day(value, field: str, day: str) -> str:
    timestamp = _positive_integer(value, field)
    try:
        observed = datetime.fromtimestamp(timestamp, TZ)
    except (ValueError, OSError, OverflowError):
        raise ProviderError(f"{field} 时间戳无效") from None
    if observed.date().isoformat() != day:
        raise ProviderError(f"{field} 日期 {observed.date()} 与请求日 {day} 不一致")
    return observed.strftime("%H:%M:%S")


def normalize_pool(payload: dict, day: str) -> tuple[list[dict], str]:
    """Validate the pool, omitting only explicitly approved defective rows."""
    valid_day(day)
    if not isinstance(payload, dict) or payload.get("code") != 20000:
        raise ProviderError(f"选股宝返回失败或未知结构：{payload.get('code') if isinstance(payload, dict) else None}")
    for key in ("date", "trade_date", "qdate"):
        if payload.get(key) is not None:
            hint = str(payload[key])
            if re.fullmatch(r"[0-9]{8}", hint):
                hint = f"{hint[:4]}-{hint[4:6]}-{hint[6:]}"
            if hint != day:
                raise ProviderError(f"来源 {key} 日期 {hint} 与请求日 {day} 不一致")
    rows = payload.get("data")
    if rows is None and "data" in payload:
        return [], "来源 data 为 null，未确认该日数据。"
    if not isinstance(rows, list):
        raise ProviderError("选股宝 data 不是完整股票数组；需要核实接口结构或分页")
    normalized = {}
    duplicates = 0
    time_anomalies = []
    ignored_rows = {}
    for raw in rows:
        if not isinstance(raw, dict):
            raise ProviderError("股票记录结构无效")
        symbol = str(raw.get("symbol", ""))
        if not re.fullmatch(r"[0-9]{6}\.(SS|SH|SZ|BJ)", symbol):
            raise ProviderError(f"股票标识格式无效：{symbol}")
        code = symbol.split(".")[0]
        name = re.sub(r"\s+", "", str(raw.get("stock_chi_name") or ""))
        if not name:
            raise ProviderError(f"{symbol} 缺少历史名称")
        ignored_fields = IGNORED_HISTORY_ZERO_FIELDS.get((day, code))
        if (ignored_fields
                and all(not isinstance(raw.get(field), bool) and raw.get(field) in (0, "0")
                        for field in ignored_fields)):
            ignored_rows[code] = ignored_fields
            continue
        boards = _positive_integer(raw.get("limit_up_days"), "limit_up_days")
        first_time = _time_on_day(raw.get("first_limit_up"), "first_limit_up", day)
        last_time = _time_on_day(raw.get("last_limit_up"), "last_limit_up", day)
        if first_time > last_time:
            # Both raw timestamps already prove the requested date. An inverted
            # intraday interval makes these optional times unknown, not the
            # entire daily closing-pool snapshot invalid. Never swap or invent.
            time_anomalies.append(code)
            first_time = last_time = None
        close = _number(raw.get("price"), "price")
        if close <= 0:
            raise ProviderError(f"{symbol} 历史价格必须大于 0")
        pct = _number(raw.get("change_percent"), "change_percent")
        turnover = _number(raw.get("turnover_ratio"), "turnover_ratio", optional=True)
        pct_percent = pct * 100
        turnover_percent = turnover * 100 if turnover is not None else None
        if not math.isfinite(pct_percent) or (turnover_percent is not None and not math.isfinite(turnover_percent)):
            raise ProviderError("百分数换算结果超出有限数值范围")
        if turnover is not None and turnover < 0:
            raise ProviderError("turnover_ratio 不得为负数")
        open_times = _number(raw.get("break_limit_up_times"), "break_limit_up_times", optional=True)
        if open_times is not None and (open_times < 0 or open_times != int(open_times) or open_times > 9223372036854775807):
            raise ProviderError("break_limit_up_times 必须为非负整数")
        reason = raw.get("surge_reason") or {}
        if not isinstance(reason, dict):
            raise ProviderError("surge_reason 结构无效")
        record = {"date": day, "code": code, "name": name, "market": market_for(code),
                  "industry": None, "boards": boards, "close": close,
                  "pct_change": pct_percent, "turnover": turnover_percent,
                  "first_time": first_time, "last_time": last_time,
                  "open_times": int(open_times) if open_times is not None else None,
                  "limit_up_reason": str(reason.get("stock_reason") or ""), "source": SOURCE}
        if code in normalized:
            if normalized[code] != record:
                raise ProviderError(f"同一日期股票 {code} 存在冲突记录")
            duplicates += 1
        else:
            normalized[code] = record
    note = f"移除 {duplicates} 条完全相同的重复记录。" if duplicates else ""
    if ignored_rows:
        fields = {"limit_up_days": "连板数", "first_limit_up": "首次封板时间", "last_limit_up": "末次封板时间"}
        skipped = "；".join(f"{code}（{'、'.join(fields[field] for field in ignored_rows[code])}为 0）"
                           for code in sorted(ignored_rows))
        note += f"已按确认跳过 {day} 的异常股票 {skipped}；其余记录逐条校验后归档，原始响应保留。"
    if time_anomalies:
        note += (f"来源 {','.join(sorted(set(time_anomalies)))} 封板时间顺序异常，"
                 "首次和末次时间按缺失保存；原始时间戳的交易日期已核验，原始响应保留。")
    return list(normalized.values()), note


def _historical_day(day: str, raw_dir: Path) -> DayResult:
    valid_day(day)
    response = _get(POOL_URL, {"pool_name": "limit_up", "date": day})
    raw_path = _save_raw(f"xgb_{day}", response, Path(raw_dir))
    try:
        payload = response.json()
        records, note = normalize_pool(payload, day)
    except (ValueError, ProviderError) as exc:
        raise ProviderError(f"{day} 数据校验失败：{exc}", raw_path) from exc
    if not records:
        return DayResult(day, [], "empty", note + "来源返回空数据且不含可确认的该日时间戳；无法据此认定休市或没有涨停。", raw_path)
    return DayResult(day, records, "ok", note, raw_path)


def normalize_cls_pool(payload: dict, day: str) -> list[dict]:
    """Validate the entire public CLS pool, including its declared row count."""
    valid_day(day)
    if not isinstance(payload, dict) or payload.get("code") != 200:
        raise ProviderError("财联社返回失败或未知结构")
    raw_rows = payload.get("data")
    if not isinstance(raw_rows, list):
        raise ProviderError("财联社 data 不是完整股票数组")
    rows, seen = [], set()
    for raw in raw_rows:
        if not isinstance(raw, dict):
            raise ProviderError("财联社股票记录结构无效")
        symbol = str(raw.get("secu_code", ""))
        if not re.fullmatch(r"(?:sh|sz|bj)[0-9]{6}", symbol):
            raise ProviderError(f"财联社股票标识无效：{symbol}")
        code = symbol[2:]
        if code in seen:
            raise ProviderError(f"财联社同日重复股票：{code}")
        seen.add(code)
        if _positive_integer(raw.get("num_stocks"), "num_stocks") != len(raw_rows):
            raise ProviderError("财联社股票总数与完整数组长度不一致")
        try:
            observed = datetime.fromisoformat(raw["time"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError("财联社缺少可核验日期的股票时间") from exc
        if observed.tzinfo is not None:
            observed = observed.astimezone(TZ)
        if observed.date().isoformat() != day:
            raise ProviderError(f"财联社股票时间日期与请求日 {day} 不一致")
        name = re.sub(r"\s+", "", str(raw.get("secu_name") or ""))
        if not name:
            raise ProviderError("财联社缺少股票名称")
        price = _number(raw.get("last_px"), "last_px")
        change = _number(raw.get("change"), "change") * 100
        if price <= 0 or not math.isfinite(change):
            raise ProviderError("财联社价格或涨幅无效")
        rows.append({"date": day, "code": code, "name": name, "market": market_for(code),
                     "industry": None, "boards": _positive_integer(raw.get("limit_up_days"), "limit_up_days"),
                     "close": price, "pct_change": change, "turnover": None,
                     # CLS's generic time proves the date; its semantics do not
                     # establish the first/last seal times used by our archive.
                     "first_time": None, "last_time": None, "open_times": None,
                     "limit_up_reason": str(raw.get("up_reason") or ""), "source": CLS_SOURCE})
    return rows


def _cls_day(day: str, raw_dir: Path, *, attempts=3) -> DayResult:
    params = {"app": "CailianpressWeb", "os": "web", "sv": "8.7.9",
              "type": "up_pool", "way": "last_px", "rever": 1}
    response = _get(CLS_POOL_URL, params, attempts=attempts)
    raw_path = _save_raw(f"cls_{day}", response, Path(raw_dir))
    try:
        rows = normalize_cls_pool(response.json(), day)
    except (ValueError, ProviderError) as exc:
        raise ProviderError(f"财联社 {day} 数据校验失败：{exc}", raw_path) from exc
    return DayResult(day, rows, "ok" if rows else "empty",
                     "财联社公开当日涨停池，整池日期及总数已校验；来源连板口径包含其停牌连续性处理。" if rows
                     else "财联社当日池为空，尚未确认该日数据。", raw_path, CLS_SOURCE)


def fetch_day(day: str, raw_dir: Path = RAW_DIR, *, now=None) -> DayResult:
    """Use CLS after today's cutoff; never assign an unstamped live pool to history."""
    from live_update import CLOSE_READY

    valid_day(day)
    current = (now or datetime.now(TZ)).astimezone(TZ)
    live_allowed = day == current.date().isoformat() and current.time() >= CLOSE_READY
    if not live_allowed:
        return _historical_day(day, raw_dir)
    failures = []
    try:
        result = _cls_day(day, raw_dir)
        if result.status == "ok":
            return result
        failures.append(result.note)
    except ProviderError as exc:
        failures.append(str(exc))
    try:
        result = _historical_day(day, raw_dir)
        if result.status == "ok":
            return result
        failures.append(result.note)
    except ProviderError as exc:
        failures.append(str(exc))
    response = _get(POOL_URL, {"pool_name": "limit_up"})
    raw_path = _save_raw(f"xgb_live_{day}", response, Path(raw_dir))
    try:
        rows, note = normalize_pool(response.json(), day)
    except (ValueError, ProviderError) as exc:
        raise ProviderError(f"当天各来源未取得可确认的数据：{'；'.join(failures)}；实时池：{exc}", raw_path) from exc
    if not rows:
        return DayResult(day, [], "empty", "当天各来源暂未返回可确认的数据；空返回不代表没有涨停。", raw_path)
    return DayResult(day, rows, "ok", "历史入口未就绪，采用封板日期已逐只校验的选股宝收盘后实时池。" + note, raw_path)


def fetch_live_day(day: str, raw_dir: Path = RAW_DIR, *, now=None) -> DayResult:
    """Read today's provisional pool without changing the closing archive policy."""
    valid_day(day)
    current = (now or datetime.now(TZ)).astimezone(TZ)
    if day != current.date().isoformat():
        raise ProviderError("盘中接口只能读取北京时间当天，不能用于历史归档")
    failures = []
    try:
        result = _cls_day(day, raw_dir, attempts=1)
        if result.status == "ok":
            return result
        failures.append(result.note)
    except ProviderError as exc:
        failures.append(str(exc))
    response = _get(POOL_URL, {"pool_name": "limit_up"}, attempts=1)
    raw_path = _save_raw(f"xgb_intraday_{day}", response, Path(raw_dir))
    try:
        rows, note = normalize_pool(response.json(), day)
    except (ValueError, ProviderError) as exc:
        raise ProviderError(f"盘中池暂不可用：{'；'.join(failures)}；{exc}", raw_path) from exc
    return DayResult(day, rows, "ok" if rows else "empty",
                     "盘中暂定涨停池，收盘后另行确认。" + note if rows else "盘中来源未返回可确认的数据，保留上次快照。",
                     raw_path)


def trading_dates(start: str, end: str, raw_dir: Path = RAW_DIR) -> tuple[list[str], str]:
    """Index bar dates are a pragmatic calendar, not exchange-certified coverage."""
    valid_day(start)
    valid_day(end)
    if start > end:
        raise ValueError("开始日期晚于结束日期")
    response = _get(CALENDAR_URL, {"param": f"sh000001,day,{start},{end},1000,"})
    raw_path = _save_raw("tencent_index_calendar", response, Path(raw_dir))
    try:
        payload = response.json()
        if payload.get("code") != 0:
            raise ProviderError("指数日线接口返回失败")
        rows = payload["data"]["sh000001"]["day"]
        if not isinstance(rows, list) or not rows:
            raise ProviderError("未取得上证指数日线日期")
        days = sorted({valid_day(row[0]) for row in rows if isinstance(row, list) and row})
        if len(days) != len(rows) or any(day < start or day > end for day in days):
            raise ProviderError("指数日线日期重复或超出请求范围")
        if len(rows) >= 1000:
            raise ProviderError("指数日线触及请求上限，可能被截断")
    except (KeyError, TypeError, ValueError, ProviderError) as exc:
        raise ProviderError(f"辅助交易日历校验失败：{exc}", raw_path) from exc
    return days, raw_path
