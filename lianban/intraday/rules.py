"""Minute validation without persistence, HTTP or workers."""
from datetime import date
import math
import re

def validate_day(day):
    if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or date.fromisoformat(day).isoformat() != day:
        raise ValueError("日期格式应为 YYYY-MM-DD")
    return day


def session_slot(value):
    """Compress lunch while retaining actual timestamps; no synthetic bars."""
    if not re.fullmatch(r"\d{2}:\d{2}", value):
        raise ValueError("分钟时间格式错误")
    hour, minute = map(int, value.split(":"))
    if hour > 23 or minute > 59:
        raise ValueError("分钟时间无效")
    total = hour * 60 + minute
    if 570 <= total <= 690:
        return total - 570
    if 780 <= total <= 900:
        return total - 660
    return None


def number(value, *, positive=False):
    if isinstance(value, bool):
        raise ValueError("行情数值无效")
    result = float(value)
    if not math.isfinite(result) or result < 0 or (positive and result <= 0):
        raise ValueError("行情数值必须有限且非负，价格必须大于零")
    return result


def previous_close(event):
    if event.get("previous_close") is not None:
        return number(event["previous_close"], positive=True)
    close = number(event["close"], positive=True)
    change = float(event["pct_change"])
    if not math.isfinite(change) or change <= -100:
        raise ValueError("涨停池缺少有效昨收计算字段")
    # Eastmoney's top-level preClose belongs to its latest session, not every
    # historical day. Derive each day's reference from that day's closing pool.
    return round(close / (1 + change / 100), 2)


def validate_points(points, event):
    if not points:
        raise ValueError("来源未返回该交易日的分时数据")
    times, slots = set(), set()
    for point in points:
        slot = session_slot(point["time"])
        if slot is None or point["time"] in times:
            raise ValueError("存在重复或非交易时段的分钟数据")
        if times and point["time"] <= max(times):
            raise ValueError("分钟数据未按时间递增")
        times.add(point["time"])
        slots.add(slot)
        point["price"] = number(point["price"], positive=True)
        point["volume"] = number(point["volume"])
        point["amount"] = number(point["amount"])
        if point.get("average") is not None:
            point["average"] = number(point["average"], positive=True)
        point["slot"] = slot
    close = number(event["close"], positive=True) if event.get("close") else None
    if close and points[-1]["time"] == "15:00" and abs(points[-1]["price"] - close) > max(0.02, close * 0.0005):
        raise ValueError("分时收盘价与当日涨停池收盘价不一致")
    missing = len(set(range(241)) - slots)
    status = "ok" if not missing else "partial"
    note = "241 个交易分钟已覆盖" if not missing else f"缺少 {missing} 个交易分钟，按实际返回展示，未补造数据"
    return status, note


def is_mainboard(code):
    return bool(re.fullmatch(r"(?:00|60)\d{4}", str(code)))
