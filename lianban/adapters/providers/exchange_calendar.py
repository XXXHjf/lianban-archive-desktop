"""Fetch and validate the exchange's annual A-share closure table."""
from datetime import date
from html.parser import HTMLParser
import re
import requests
from lianban.core.trading_calendar import date_range

URL = "https://www.sse.com.cn/disclosure/dealinstruc/closed/"


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def parse_calendar(html):
    parser = _Text()
    parser.feed(html)
    text = re.sub(r"\s+", "", "".join(parser.parts))
    years = set(re.findall(r"(\d{4})年休市安排", text))
    if len(years) != 1:
        raise ValueError("交易所年度日历年份不明确")
    year = int(years.pop())
    weekday = r"(?:[（(]星期.[）)])?"
    pattern = rf"(\d{{1,2}})月(\d{{1,2}})日{weekday}(?:至(?:(\d{{1,2}})月)?(\d{{1,2}})日{weekday})?休市"
    periods = re.findall(pattern, text)
    if not 6 <= len(periods) <= 8:
        raise ValueError("交易所年度休市安排不完整，保留已有日历")
    closed = set()
    for month, day, end_month, end_day in periods:
        start = date(year, int(month), int(day)).isoformat()
        finish = date(year, int(end_month or month), int(end_day or day)).isoformat()
        span = list(date_range(start, finish))
        if not 1 <= len(span) <= 15:
            raise ValueError("交易所休市日期范围异常")
        closed.update(span)
    if not 10 <= len(closed) <= 60 or f"{year}-01-01" not in closed or f"{year}-10-01" not in closed:
        raise ValueError("交易所年度休市日期校验失败")
    return {"year": year, "closed_dates": sorted(closed), "source": URL}


def fetch_calendar():
    response = requests.get(URL, timeout=12, headers={"User-Agent": "Mozilla/5.0"})
    response.raise_for_status()
    response.encoding = "utf-8"
    return parse_calendar(response.text)
