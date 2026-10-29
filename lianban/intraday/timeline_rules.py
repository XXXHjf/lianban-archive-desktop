"""Pure minute-event derivation and bounded cross-stock associations."""
from decimal import Decimal, ROUND_HALF_UP
import math
import re
from statistics import median

SEAL_KINDS = ("seal", "relock", "last_seal")

def clock_seconds(clock):
    if not isinstance(clock, str) or not re.fullmatch(r"\d{2}:\d{2}(?::\d{2})?", clock):
        return None
    parts = list(map(int, clock.split(":")))
    hour, minute, second = parts[0], parts[1], parts[2] if len(parts) > 2 else 0
    return hour * 3600 + minute * 60 + second if hour < 24 and minute < 60 and second < 60 else None


def regular_time(clock):
    second = clock_seconds(clock)
    return second is not None and (34200 <= second <= 41400 or 46800 <= second <= 54000)


def cents(value):
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def stock_events(stock, points, auction=None, multiple=3):
    """Minute observations never claim to reconstruct intra-minute order books."""
    events = []
    limit = cents(stock["close"]) if stock.get("close") and math.isfinite(float(stock["close"])) and float(stock["close"]) > 0 else None
    first = stock.get("first_time")
    first_second = clock_seconds(first)

    def add(kind, label, clock, precision, detail, **fields):
        second = clock_seconds(clock)
        if not regular_time(clock):
            return
        events.append({"id": f"{stock['code']}-{kind}-{clock}", "code": stock["code"],
                       "name": stock["name"], "boards": stock["boards"], "kind": kind,
                       "label": label, "time": clock, "minute": second // 60,
                       "precision": precision, "detail": detail, **fields})

    if first_second is not None:
        add("seal", "首次封板", first, "source", f"{stock.get('clock_source', '当日收盘涨停池')}提供的首次封板时间")
    last = stock.get("last_time")
    last_second = clock_seconds(last)
    if first_second is not None and last_second is not None and last_second > first_second:
        add("last_seal", "最终封板", last, "source", f"{stock.get('clock_source', '当日收盘涨停池')}提供的最后封板时间")

    adjusted = [dict(p) for p in points]
    match = (auction or {}).get("points", [])
    match = next((p for p in match if p.get("time") == "09:25"), None)
    if match:
        for point in adjusted:
            if point["time"] == "09:30" and point["volume"] >= match["volume"]:
                point["volume"] -= match["volume"]
    day_volume = sum(p["volume"] for p in adjusted)
    seen_limit, previous, recent = False, None, []
    for point in adjusted:
        minute = clock_seconds(point["time"]) // 60
        at_limit = limit is not None and cents(point["price"]) == limit
        adjacent = previous is not None and minute - previous["minute"] == 1
        if not adjacent:
            recent = []
        if at_limit:
            if not seen_limit:
                if first_second is None:
                    add("seal", "涨停价出现", point["time"], "minute", "本地分时首次观察到涨停价，不等同于全天首次封板", price=point["price"])
                seen_limit = True
            elif adjacent and not previous["at_limit"]:
                add("relock", "回封观察", point["time"], "minute", "相邻分钟价格由低于涨停价回到涨停价", price=point["price"])
        elif adjacent and previous["at_limit"]:
            add("break", "开板观察", point["time"], "minute", "相邻分钟价格由涨停价降至涨停价以下", price=point["price"])
        if len(recent) >= 5 and 570 < minute < 897:
            baseline = median(recent[-5:])
            volume = point["volume"]
            if baseline > 0 and volume >= multiple * baseline and volume >= max(10000, day_volume * .005):
                add("volume", "放量", point["time"], "minute", "本分钟量达到此前连续5分钟中位数的指定倍数，且不低于日内量0.5%和100手",
                    volume=volume, baseline=baseline, ratio=round(volume / baseline, 2), price=point["price"])
        recent.append(point["volume"])
        previous = {"minute": minute, "at_limit": at_limit}
    return events


def associate(events, window):
    events = sorted((event for event in events if regular_time(event.get("time"))),
                    key=lambda e: (e["minute"], clock_seconds(e["time"]), -e["boards"], e["code"], e["kind"]))
    for index, event in enumerate(events):
        event["related"] = []
        if event["kind"] not in SEAL_KINDS:
            continue
        for other_index, other in enumerate(events):
            simultaneous = other["kind"] in SEAL_KINDS
            if other["kind"] not in (*SEAL_KINDS, "break", "volume") or (simultaneous and other_index <= index):
                continue
            delta = other["minute"] - event["minute"]
            if other["code"] != event["code"] and abs(delta) <= window:
                event["related"].append({k: v for k, v in other.items() if k != "related"} |
                                        {"delta": delta, "interaction_kind": "simultaneous" if simultaneous else other["kind"]})
    return events


def interaction_groups(events, window):
    """Cross-stock seal/seal or seal/change pairs, without unbounded temporal chaining."""
    groups, pending = [], None

    def finish(group):
        ordered = sorted(group["events"].values(), key=lambda e: (e["minute"], clock_seconds(e["time"]), -e["boards"], e["code"], e["kind"]))
        codes = {event["code"] for event in ordered}
        if len(codes) < 2:
            return
        groups.append({"id": "interaction-" + group["anchors"][0],
                       "start": ordered[0]["time"][:5], "end": ordered[-1]["time"][:5],
                       "minute": ordered[0]["minute"], "end_minute": ordered[-1]["minute"],
                       "stock_count": len(codes), "events": ordered,
                       "kinds": sorted({link["kind"] for link in group["links"]}),
                       "links": group["links"]})

    for anchor in sorted((event for event in events if regular_time(event.get("time"))),
                         key=lambda e: (e["minute"], clock_seconds(e["time"]), e["id"])):
        if anchor["kind"] not in SEAL_KINDS:
            continue
        peers = [event for event in anchor.get("related", [])
                 if event["code"] != anchor["code"] and event["kind"] in (*SEAL_KINDS, "break", "volume")
                 and regular_time(event.get("time"))
                 and abs(event["minute"] - anchor["minute"]) <= window]
        if not peers:
            continue
        members = {event["id"]: {k: v for k, v in event.items() if k not in ("related", "delta", "interaction_kind")} for event in [anchor, *peers]}
        low, high = min(event["minute"] for event in members.values()), max(event["minute"] for event in members.values())
        if pending and (anchor["minute"] - pending["last_anchor"] > window
                        or max(high, pending["high"]) - min(low, pending["low"]) > 2 * window):
            finish(pending)
            pending = None
        if pending is None:
            pending = {"anchors": [], "events": {}, "links": [], "low": low, "high": high}
        pending["anchors"].append(anchor["id"])
        pending["events"].update(members)
        pending["links"].extend({"anchor_id": anchor["id"], "event_id": event["id"],
                                 "delta": event["minute"] - anchor["minute"],
                                 "kind": "simultaneous" if event["kind"] in SEAL_KINDS else event["kind"]} for event in peers)
        pending["low"], pending["high"] = min(low, pending["low"]), max(high, pending["high"])
        pending["last_anchor"] = anchor["minute"]
    if pending:
        finish(pending)
    return sorted(groups, key=lambda group: (group["minute"], group["end_minute"], group["id"]))
