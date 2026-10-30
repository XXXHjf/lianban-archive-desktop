"""Stock identification and pool-record validation, independent of persistence."""
from datetime import date
from decimal import Decimal, InvalidOperation
from functools import lru_cache
import math
import re
import unicodedata


def market_for(code):
    if code.startswith(("688", "689")):
        return "科创板"
    if code.startswith(("300", "301")):
        return "创业板"
    if code.startswith(("8", "4", "92")):
        return "北交所"
    return "沪市主板" if code.startswith("6") else "深市主板"


@lru_cache(maxsize=20000)
def is_st_name(name):
    normalized = re.sub(r"\s+", "", unicodedata.normalize("NFKC", name or "")).upper()
    return bool(re.match(r"^(?:S\*ST|SST|\*ST|ST)", normalized))


def validated_records(day, records, source):
    """Validate the complete snapshot before any fact or provisional write."""
    if date.fromisoformat(day).isoformat() != day:
        raise ValueError("日期必须是 YYYY-MM-DD")
    clean = []
    seen = set()
    for item in records:
        row = dict(item)
        code = str(row["code"])
        if len(code) != 6 or not code.isascii() or not code.isdigit():
            raise ValueError("股票代码必须是六位数字")
        if code in seen:
            raise ValueError("同一交易日有重复股票")
        seen.add(code)
        if row.get("date", day) != day:
            raise ValueError("数据返回日期与请求日期不一致")
        try:
            board_value = Decimal(str(row["boards"]))
        except (InvalidOperation, ValueError) as exc:
            raise ValueError("连板数必须为正整数") from exc
        if not board_value.is_finite() or board_value != board_value.to_integral_value() or board_value < 1:
            raise ValueError("涨停池的连板数必须大于等于 1")
        if not isinstance(row.get("name"), str) or not row["name"].strip():
            raise ValueError("股票名称不能为空")
        for field in ("close", "pct_change", "turnover"):
            if row.get(field) is not None and not math.isfinite(float(row[field])):
                raise ValueError(f"{field} 不是有效数值")
        row.update(date=day, code=code, boards=int(board_value), source=source,
                   market=row.get("market") or market_for(code))
        clean.append(row)
    return clean
