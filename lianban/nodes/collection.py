"""Explicit opening evidence collection and idempotent closing-node detection."""
from contextlib import closing
from decimal import Decimal
import json
from pathlib import Path
import sqlite3
import threading
import time
from lianban.core.clock import now_iso, target_day
from lianban.storage import connect
from lianban.storage.transaction import transaction
from lianban.storage.settings import get_settings, set_settings
from lianban.intraday.store import store_path
from lianban.intraday.network import fetch_json
from . import service
from .rules import unique_anchor, node_kind

DAILY_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
QUOTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/day/query'


def daily_opening(payload, day, code):
    data = payload.get('data') if isinstance(payload, dict) else None
    if not isinstance(data, dict) or data.get('code') != code or payload.get('rc') != 0:
        raise ValueError('日K来源股票代码或状态不一致')
    lines = [line.split(',') for line in data.get('klines', []) if isinstance(line, str) and line.split(',')[0] == day]
    if len(lines) != 1 or len(lines[0]) < 10:
        raise ValueError('来源没有提供所选日期的日K开盘数据')
    cells = lines[0]
    opening = Decimal(cells[1])
    previous = Decimal(cells[2]) - Decimal(cells[9])
    node_kind(opening, previous)
    return float(opening), float(previous)


def fetch_opening(path, day, code):
    raw_dir = Path(path).resolve().parent / 'node_raw'
    symbol = ('sh' if code.startswith('6') else 'bj' if code.startswith(('4', '8', '92')) else 'sz') + code
    cached = cached_opening(path, day, code)
    if cached:
        return cached
    # qt has the exchange opening and yesterday's close, unlike a minute sample.
    try:
        payload, raw = fetch_json(QUOTE_URL, {'code': symbol}, raw_dir, f'opening_{day}_{code}')
        quote = payload['data'][symbol]['qt'][symbol]
        if payload.get('code') == 0 and quote[2] == code and str(quote[30]).startswith(day.replace('-', '')):
            node_kind(quote[5], quote[4])
            return float(quote[5]), float(quote[4]), '腾讯财经当日开盘及昨收', raw
    except (KeyError, IndexError, TypeError, ValueError, OSError):
        pass
    payload, raw = fetch_json(DAILY_URL, {
        'secid': ('1' if code.startswith('6') else '0') + '.' + code,
        'klt': 101, 'fqt': 0, 'beg': day.replace('-', ''), 'end': day.replace('-', ''),
        'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    }, raw_dir, f'daily_opening_{day}_{code}')
    opening, previous = daily_opening(payload, day, code)
    return opening, previous, '东方财富未复权日K开盘及当日涨跌额推导昨收', raw


def cached_opening(path, day, code):
    """Reuse verified 09:25 executions; never substitute the first minute price."""
    minute_path = store_path(path)
    if not minute_path.is_file():
        return None
    try:
        with closing(sqlite3.connect(minute_path.as_uri() + '?mode=ro', uri=True)) as conn:
            row = conn.execute('SELECT a.points_json,s.previous_close,a.raw_path,c.reference_basis '
                               'FROM auctions a JOIN sessions s USING(date,code) JOIN session_context c USING(date,code) '
                               "WHERE a.date=? AND a.code=? AND a.status='match_only'", (day, code)).fetchone()
        if row and '未校正除权' not in row[3]:
            points = json.loads(row[0])
            if len(points) == 1 and points[0].get('time') == '09:25':
                node_kind(points[0]['price'], row[1])
                return points[0]['price'], row[1], '分时缓存09:25实际撮合及已核对昨收', row[2]
    except (sqlite3.Error, ValueError, KeyError, TypeError):
        return None
    return None


def sync_day(path, day, *, fetcher=fetch_opening):
    service.valid_day(day)
    with closing(connect(path)) as conn:
        days = service.calendar(conn)
        previous = next((d for d in reversed(days) if d < day), None)
        rows = service.confirmed_rows(conn, day)
        prior = service.confirmed_rows(conn, previous) if previous else None
        if rows is None or prior is None:
            status, note = 'pending', '相邻交易日收盘档案不完整，暂缓判断'
        else:
            anchor = unique_anchor(prior)
            if not anchor or anchor['code'] in {r['code'] for r in rows}:
                status, note = 'none', '前日最高板并列或没有唯一锚定，或锚定股当天仍涨停'
            else:
                code = anchor['code']
                quote = conn.execute('SELECT * FROM node_openings WHERE date=? AND code=?', (day, code)).fetchone()
                try:
                    if not quote:
                        opening, previous_close, source, raw = fetcher(path, day, code)
                        node_kind(opening, previous_close)
                        with transaction(conn):
                            conn.execute('INSERT OR IGNORE INTO node_openings VALUES (?,?,?,?,?,?)',
                                         (day, code, opening, previous_close, source, raw))
                        quote = conn.execute('SELECT * FROM node_openings WHERE date=? AND code=?', (day, code)).fetchone()
                    kind = node_kind(quote['opening'], quote['previous_close'])
                    height = 2 if kind == 'low_open' else 1
                    previous_firsts = {r['code'] for r in prior if r['boards'] == 1}
                    members = {r['code'] for r in rows if r['boards'] == height and (height == 1 or r['code'] in previous_firsts)}
                    if members:
                        name = anchor['name'] + ('低开' if kind == 'low_open' else '断板')
                        evidence = f"{previous} 唯一最高 {anchor['boards']}板；{day} 开盘 {quote['opening']:g} / 昨收 {quote['previous_close']:g}；收盘未涨停；{quote['source']}"
                        identity = f'auto:{day}:{code}:{kind}'
                        with transaction(conn):
                            service.create(conn, day, height, name, kind=kind, anchor=code,
                                           evidence=evidence, identity=identity, members=members)
                            # A corrected birth-day pool replaces the original cohort, not exclusions.
                            conn.execute('DELETE FROM cycle_node_members WHERE node_id=?', (identity,))
                            conn.executemany('INSERT INTO cycle_node_members VALUES (?,?,?)',
                                             [(identity, r['code'], r['name']) for r in rows if r['code'] in members])
                        status, note = 'ok', identity
                    else:
                        status, note = 'none', '锚定符合条件，但该梯队没有可绑定的股票'
                except Exception as exc:
                    status, note = 'pending', f'开盘证据待补充：{type(exc).__name__}：{str(exc)[:120]}'
        with transaction(conn):
            conn.execute('INSERT INTO node_checks VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET status=excluded.status,note=excluded.note,checked_at=excluded.checked_at',
                         (day, status, note, now_iso()))
        return {'date': day, 'status': status, 'note': '节点已识别' if status == 'ok' else note}


class Refresher:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._last = 0

    def maybe_refresh(self, *args):
        with self._lock:
            if self._stop.is_set() or (self._thread and self._thread.is_alive()) or time.monotonic() - self._last < 240:
                return
            self._last = time.monotonic()
            self._thread = threading.Thread(target=self._run, name='ladder-nodes', daemon=True)
            self._thread.start()

    def _run(self):
        with closing(connect(self.path)) as conn:
            initial = [r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok' AND date<=? ORDER BY date DESC LIMIT 20", (target_day(),))]
            if not initial:
                return
            start = get_settings(conn).get('node_detection_start') or min(initial)
            set_settings(conn, node_detection_start=start)
            days = [r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok' AND date BETWEEN ? AND ? ORDER BY date DESC", (start, target_day()))]
        for day in days:
            if self._stop.is_set():
                return
            sync_day(self.path, day)

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
