"""Node writes and historical projections; all reads are offline."""
from datetime import date
import re
import uuid
from lianban.core.clock import now_iso, target_day
from lianban.core.stock import is_st_name
from lianban.storage.settings import get_settings
from lianban.storage.transaction import transaction
from .rules import survivors


def valid_day(day):
    if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        raise ValueError('日期格式应为 YYYY-MM-DD')
    date.fromisoformat(day)
    return day


def calendar(conn):
    return sorted(set(get_settings(conn).get('calendar_dates') or []) |
                  {r[0] for r in conn.execute('SELECT date FROM days')})


def confirmed_rows(conn, day):
    state = conn.execute('SELECT status FROM days WHERE date=?', (day,)).fetchone()
    if not state or state[0] != 'ok' or day > target_day():
        return None
    return [dict(r) for r in conn.execute('SELECT code,name,boards FROM events WHERE date=?', (day,))
            if not is_st_name(r['name'])]


def create(conn, day, boards, name, *, kind='manual', anchor='', evidence='', identity=None, members=None):
    valid_day(day)
    if isinstance(boards, bool) or not isinstance(boards, int) or not 1 <= boards <= 100:
        raise ValueError('请选择1至100的梯队板数')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 60:
        raise ValueError('节点名称应为1至60字')
    name = name.strip()
    if name.endswith('节点'):
        name = name[:-2].strip()
    if not name:
        raise ValueError('请输入具体的节点名称')
    with transaction(conn):
        rows = confirmed_rows(conn, day)
        if rows is None:
            raise ValueError('仅支持已确认收盘的交易日，请等待收盘数据完整后操作')
        selected = [r for r in rows if r['boards'] == boards and (members is None or r['code'] in members)]
        if not selected:
            raise ValueError('该梯队没有符合条件的涨停股票')
        node_id = identity or uuid.uuid4().hex
        conn.execute('INSERT INTO cycle_nodes VALUES (?,?,?,?,?,?,?,NULL,?) ON CONFLICT(id) DO NOTHING',
                     (node_id, day, boards, name, kind, anchor, evidence, now_iso()))
        conn.executemany('INSERT OR IGNORE INTO cycle_node_members VALUES (?,?,?)',
                         [(node_id, r['code'], r['name']) for r in selected])
    return {'id': node_id}


def remove(conn, node_id, day, code=None):
    valid_day(day)
    with transaction(conn):
        node = conn.execute('SELECT * FROM cycle_nodes WHERE id=?', (node_id,)).fetchone()
        if not node or day < node['date'] or confirmed_rows(conn, day) is None:
            raise ValueError('请选择节点出生后已确认收盘的交易日')
        if code is None:
            conn.execute('UPDATE cycle_nodes SET deleted_from=CASE WHEN deleted_from IS NULL OR deleted_from>? THEN ? ELSE deleted_from END WHERE id=?',
                         (day, day, node_id))
        else:
            if not conn.execute('SELECT 1 FROM cycle_node_members WHERE node_id=? AND code=?', (node_id, code)).fetchone():
                raise ValueError('该股票不属于此节点')
            conn.execute('INSERT INTO cycle_node_exclusions VALUES (?,?,?) ON CONFLICT(node_id,code) DO UPDATE SET date=MIN(date,excluded.date)',
                         (node_id, code, day))
    return {'ok': True}


def view(conn, day):
    valid_day(day)
    dates = calendar(conn)
    rows_by_day = {}
    records = []
    for item in conn.execute('SELECT * FROM cycle_nodes WHERE date<=? ORDER BY date DESC,created_at', (day,)):
        node = dict(item)
        members = [dict(r) for r in conn.execute('SELECT code,name FROM cycle_node_members WHERE node_id=? ORDER BY code', (node['id'],))]
        exclusions = {r['code']: r['date'] for r in conn.execute('SELECT * FROM cycle_node_exclusions WHERE node_id=?', (node['id'],))}
        sessions = []
        for session_day in dates:
            if node['date'] < session_day <= day:
                if session_day not in rows_by_day:
                    rows_by_day[session_day] = confirmed_rows(conn, session_day)
                sessions.append(rows_by_day[session_day])
        born = confirmed_rows(conn, node['date'])
        born_codes = {r['code'] for r in born or [] if r['boards'] == node['boards']}
        initial = {r['code'] for r in members} & born_codes
        alive, height, pending = survivors(initial, node['boards'], sessions)
        deleted = bool(node['deleted_from'] and node['deleted_from'] <= day)
        alive -= {code for code, effective in exclusions.items() if effective <= day}
        pending = pending or born is None or confirmed_rows(conn, day) is None
        state = 'deleted' if deleted else 'pending' if pending and alive else 'active' if alive else 'expired'
        if node['kind'] != 'manual' and not deleted:
            check = conn.execute('SELECT status,note FROM node_checks WHERE date=?', (node['date'],)).fetchone()
            if not check or check['status'] == 'pending':
                state = 'pending'
            elif check['status'] != 'ok' or check['note'] != node['id']:
                state = 'superseded'
        node['deleted_from'] = node['deleted_from'] if deleted else None
        node.update(members=[{**r, 'active': r['code'] in alive and state == 'active',
                              'excluded_from': exclusions.get(r['code']) if exclusions.get(r['code'], '9999') <= day else None} for r in members],
                    codes=sorted(alive) if state == 'active' else [], height=height, status=state)
        records.append(node)
    check = conn.execute('SELECT * FROM node_checks WHERE date=?', (day,)).fetchone()
    check = dict(check) if check else None
    if check and check['status'] == 'ok':
        check['note'] = '节点已识别'
    return {'date': day, 'nodes': records, 'check': check}


def decorate(conn, day, rows):
    result = view(conn, day)
    active = [node for node in result['nodes'] if node['status'] == 'active']
    for row in rows:
        row['nodes'] = [{'id': n['id'], 'name': n['name'], 'date': n['date'], 'kind': n['kind']}
                        for n in active if row['code'] in n['codes']]
    return result
