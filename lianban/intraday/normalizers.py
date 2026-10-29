"""Convert source-specific payloads into validated minute inputs."""
from datetime import datetime
import re
from .rules import number, session_slot

def normalize_eastmoney(payload, event):
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("rc") != 0 or not isinstance(data, dict) or data.get("code") != event["code"]:
        raise ValueError("东方财富返回状态或股票代码不一致")
    points = []
    for raw in data.get("trends", []):
        cells = raw.split(",")
        if len(cells) != 8:
            raise ValueError("东方财富分时字段数量异常")
        stamp = datetime.strptime(cells[0], "%Y-%m-%d %H:%M")
        if stamp.date().isoformat() != event["date"]:
            continue
        clock = stamp.strftime("%H:%M")
        if session_slot(clock) is None:
            continue
        points.append({"time": clock, "price": cells[2], "volume": number(cells[5]) * 100,
                       "amount": cells[6], "average": cells[7] if float(cells[7]) > 0 else None})
    return points


def normalize_tencent(payload, event):
    prefix = "sh" if event["code"].startswith("6") else "bj" if event["code"].startswith(("4", "8", "92")) else "sz"
    symbol = prefix + event["code"]
    if not isinstance(payload, dict) or payload.get("code") != 0 or symbol not in payload.get("data", {}):
        raise ValueError("腾讯返回状态或股票代码不一致")
    days = payload["data"][symbol].get("data", [])
    day = next((item for item in days if item.get("date") == event["date"].replace("-", "")), None)
    if day is None:
        available = sorted({item["date"] for item in days if isinstance(item, dict) and re.fullmatch(r"\d{8}", str(item.get("date", "")))})
        coverage = f"；本次返回 {available[0][:4]}-{available[0][4:6]}-{available[0][6:]} 至 {available[-1][:4]}-{available[-1][4:6]}-{available[-1][6:]}" if available else ""
        raise ValueError(f"免费分时来源未提供 {event['date']} 的分钟数据{coverage}")
    points, last_volume, last_amount = [], 0, 0
    for raw in day.get("data", []):
        cells = raw.split()
        if len(cells) != 4 or not re.fullmatch(r"\d{4}", cells[0]):
            raise ValueError("腾讯分时字段异常")
        clock = cells[0][:2] + ":" + cells[0][2:]
        if session_slot(clock) is None:
            continue
        volume, amount = number(cells[2]) * 100, number(cells[3])
        if volume < last_volume or amount < last_amount:
            raise ValueError("腾讯累计成交量额出现倒退")
        points.append({"time": clock, "price": cells[1], "volume": volume - last_volume,
                       "amount": amount - last_amount, "average": amount / volume if volume else None})
        last_volume, last_amount = volume, amount
    return points


def tencent_reference(payload, symbol, day):
    data = payload["data"][symbol]
    quote = data.get("qt", {}).get(symbol, [])
    if len(quote) > 30 and str(quote[30]).startswith(day.replace("-", "")):
        return number(quote[4], positive=True), "腾讯当日昨收字段"
    previous = sorted((r for r in data.get("data", []) if r.get("date", "") < day.replace("-", "")), key=lambda r: r["date"])
    for session in reversed(previous):
        closing = [r.split() for r in session.get("data", []) if r.split()[0] == "1500"]
        if closing:
            return number(closing[-1][1], positive=True), "前交易日分时收盘参考（未校正除权）"
    raise ValueError("来源未提供可核对的当日昨收或前交易日收盘参考")


def normalize_auction(payload, symbol, points):
    if not isinstance(payload, list):
        raise ValueError("竞价来源返回无效")
    rows = [r for r in payload if r.get("symbol") == symbol and r.get("ticktime") == "09:25:00"]
    if not rows:
        return []
    if len(rows) != 1:
        raise ValueError("竞价撮合记录重复")
    row = rows[0]
    price, volume = number(row["price"], positive=True), number(row["volume"])
    opening = next((p for p in points if p["time"] == "09:30"), None)
    if opening and (abs(price - opening["price"]) > 0.011 or volume > opening["volume"]):
        raise ValueError("竞价撮合价量与所选日期分时开盘记录不一致")
    return [{"time": "09:25", "price": price, "volume": volume, "amount": round(price * volume, 2)}]
