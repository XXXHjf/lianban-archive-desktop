"""Point-in-time stock relationships derived from archived pool observations.

A missing pool member is not proof of a failed limit-up. Win/loss candidates
therefore retain their evidence and are always marked pending verification.
"""
from __future__ import annotations
from collections import defaultdict
from bisect import bisect_left, bisect_right
from .models import Observation, CoverageStatus
from lianban.core.stock import is_st_name

def competition_group(row):
    market = row['market']
    if market in ('沪市主板', '深市主板'):
        market = '主板'
    risk_warning = is_st_name(row['name'])
    return (market, risk_warning)

def _add_period_leaders(observations, segments, code, peer_code, end, indices, exclude_st=False, exclude_gem=False):
    """Pick another stock by the full observed run that intersects each period."""
    # Index the supplied facts once. A period only visits its date slice, and
    # each eligible stock's complete history is traversed once below.
    chronological = sorted(observations, key=lambda row: (row['date'], row['code']))
    dates = [row['date'] for row in chronological]
    by_code = defaultdict(list)
    for row in chronological:
        by_code[row['code']].append(row)
    eligible = defaultdict(list)
    for index, segment in enumerate(segments):
        segment['leader'] = None
        first = bisect_left(dates, segment['start'])
        last = bisect_right(dates, segment['end'])
        members = set()
        for row in chronological[first:last]:
            if row['code'] in (code, peer_code):
                continue
            if (exclude_st and is_st_name(row['name'])) or (exclude_gem and row['code'].startswith(('300', '301'))):
                continue
            members.add(row['code'])
        for member in members:
            eligible[member].append(index)
    ranks = {}

    def consider(run):
        if exclude_st and is_st_name(run['name']):
            return
        dates = run['dates']
        height = dates[-1]['boards']
        for index in eligible[run['code']]:
            segment = segments[index]
            overlap = next((row['date'] for row in reversed(dates) if segment['start'] <= row['date'] <= segment['end']), None)
            if overlap is None:
                continue
            rank = (height, overlap)
            previous = segment['leader']
            if previous is None or rank > ranks[index] or (rank == ranks[index] and run['code'] < previous['code']):
                ranks[index] = rank
                segment['leader'] = {'code': run['code'], 'name': run['name'], 'max_boards': height, 'start': dates[0]['date'], 'end': dates[-1]['date'], 'dates': dates}
    for candidate in sorted(eligible):
        current = None
        for row in by_code[candidate]:
            if row['date'] > end:
                break
            previous = current['dates'][-1] if current else None
            connected = current is not None and row['boards'] == previous['boards'] + 1 and indices[row['date']] == indices[previous['date']] + 1
            if not connected:
                if current:
                    consider(current)
                current = {'code': row['code'], 'name': row['name'], 'dates': []}
            current['name'] = row['name']
            current['dates'].append({'date': row['date'], 'boards': row['boards']})
        if current:
            consider(current)


def stock_pair_comparison(observations: list[Observation], coverage: dict[str, CoverageStatus], code, peer_code, start, end, settings, exclude_st=False, exclude_gem=False, *, include_period_leaders=True):
    """Full observed runs for two stocks, grouped by shared limit-up days.

    Only consecutive, successful trading-day observations with increasing
    heights join a run. Missing dates and unseen first boards are never filled.
    """
    coverage = {row['date']: row['status'] for row in [{'date': day, 'status': status} for day, status in coverage.items() if day <= end]}
    calendar = sorted((day for day in set(settings.get('calendar_dates', [])) | set(coverage) if day <= end))
    indices = {day: index for index, day in enumerate(calendar)}
    rows = [dict(row) for row in sorted((r for r in observations if r['code'] in (code, peer_code) and r['date'] <= end), key=lambda r: (r['date'], r['code']))]
    runs, current = ([], {})
    for row in rows:
        previous = current.get(row['code'])
        if previous is None or row['boards'] != previous['dates'][-1]['boards'] + 1 or indices[row['date']] != indices[previous['dates'][-1]['date']] + 1:
            previous = {'code': row['code'], 'dates': []}
            runs.append(previous)
            current[row['code']] = previous
        previous['dates'].append({'date': row['date'], 'boards': row['boards']})
    parent = list(range(len(runs)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index
    day_runs = defaultdict(dict)
    for index, run in enumerate(runs):
        for observation in run['dates']:
            if start <= observation['date'] <= end:
                day_runs[observation['date']][run['code']] = index
    shared = {}
    for day, members in day_runs.items():
        if code in members and peer_code in members:
            parent[root(members[peer_code])] = root(members[code])
            shared[day] = members[code]
    groups = defaultdict(lambda: {'target_dates': [], 'peer_dates': [], 'common_dates': []})
    related_roots = {root(index) for index in shared.values()}
    for index, run in enumerate(runs):
        group_id = root(index)
        if group_id in related_roots:
            key = 'target_dates' if run['code'] == code else 'peer_dates'
            groups[group_id][key].extend(run['dates'])
    for day, index in shared.items():
        groups[root(index)]['common_dates'].append(day)
    segments = []
    for segment in groups.values():
        for key in ('target_dates', 'peer_dates', 'common_dates'):
            segment[key].sort(key=(lambda row: row['date']) if key != 'common_dates' else None)
        days = [row['date'] for key in ('target_dates', 'peer_dates') for row in segment[key]]
        segments.append({**segment, 'start': min(days), 'end': max(days)})
    segments.sort(key=lambda segment: (segment['end'], segment['start']), reverse=True)
    if include_period_leaders:
        _add_period_leaders(observations, segments, code, peer_code, end, indices, exclude_st, exclude_gem)
    return {'code': code, 'peer_code': peer_code, 'range_start': start, 'range_end': end, 'segments': segments}

def stock_relationships(observations: list[Observation], coverage: dict[str, CoverageStatus], code, start, end, settings):
    rows = [dict(row) for row in sorted((r for r in observations if start <= r['date'] <= end), key=lambda r: (r['date'], r['code']))]
    by_date = defaultdict(dict)
    target_days = []
    for row in rows:
        by_date[row['date']][row['code']] = row
        if row['code'] == code and not is_st_name(row['name']):
            target_days.append(row)
    coverage = {row['date']: row['status'] for row in [{'date': day, 'status': status} for day, status in coverage.items() if start <= day <= end]}
    calendar = sorted(set(settings.get('calendar_dates', [])) | set(coverage))
    next_dates = {day: calendar[i + 1] for i, day in enumerate(calendar[:-1])}
    opponents, cooccurrences, rounds = ({}, {}, [])
    for target in target_days:
        day, height = (target['date'], target['boards'])
        for peer in by_date[day].values():
            if peer['code'] == code or is_st_name(peer['name']):
                continue
            common = cooccurrences.setdefault(peer['code'], {'code': peer['code'], 'name': peer['name'], 'market': peer['market'], 'dates': []})
            common['name'] = peer['name']
            common['dates'].append({'date': day, 'target_boards': height, 'peer_boards': peer['boards']})
        peers = [peer for peer in by_date[day].values() if peer['code'] != code and not is_st_name(peer['name']) and peer['boards'] == height and (competition_group(peer) == competition_group(target))]
        next_day = next_dates.get(day)
        within_range = bool(next_day and next_day <= end)
        ready = within_range and coverage.get(next_day) == 'ok'
        next_rows = by_date.get(next_day, {}) if ready else {}
        raw_target_next = next_rows.get(code)
        target_next_excluded = bool(raw_target_next and is_st_name(raw_target_next['name']))
        target_next = None if target_next_excluded else raw_target_next
        target_advanced = bool(target_next and target_next['boards'] == height + 1)
        round_record = {'date': day, 'next_date': next_day if within_range else None, 'next_trading_date': next_day, 'boards': height, 'peer_count': len(peers), 'wins': [], 'losses': [], 'together_count': 0, 'unresolved_count': 0, 'status': 'compared' if ready else 'missing' if within_range else 'cutoff', 'target_next_boards': target_next['boards'] if target_next else None}
        round_record['cohort'] = []
        for member in [target, *peers]:
            following = next_rows.get(member['code'])
            if following and is_st_name(following['name']):
                following = None
                promotion = 'pending'
            else:
                promotion = 'pending' if not ready else 'advanced' if following and following['boards'] == height + 1 else 'other_height' if following else 'not_in_pool'
            round_record['cohort'].append({'code': member['code'], 'name': member['name'], 'boards': height, 'next_boards': following['boards'] if following else None, 'promotion_status': promotion, 'is_target': member['code'] == code})
        for peer in peers:
            peer_next = next_rows.get(peer['code'])
            peer_next_excluded = bool(peer_next and is_st_name(peer_next['name']))
            if peer_next_excluded:
                peer_next = None
            peer_advanced = bool(peer_next and peer_next['boards'] == height + 1)
            outcome = None
            if target_next_excluded or peer_next_excluded:
                round_record['unresolved_count'] += 1
            elif ready and target_advanced and (peer_next is None):
                outcome = 'wins'
            elif ready and peer_advanced and (target_next is None):
                outcome = 'losses'
            elif ready and target_advanced and peer_advanced:
                round_record['together_count'] += 1
            else:
                round_record['unresolved_count'] += 1
            if outcome:
                round_record[outcome].append({'code': peer['code'], 'name': peer['name']})
                rival = opponents.setdefault(peer['code'], {'code': peer['code'], 'name': peer['name'], 'market': peer['market'], 'wins': [], 'losses': []})
                rival['name'] = peer['name']
                rival[outcome].append({'date': day, 'next_date': next_day, 'boards': height, 'verification': 'pending', 'evidence': 'promotion_vs_not_in_pool'})
        if not peers:
            round_record['outcome'] = 'no_peers'
        elif not ready:
            round_record['outcome'] = round_record['status']
        elif round_record['wins']:
            round_record['outcome'] = 'win'
        elif round_record['losses']:
            round_record['outcome'] = 'loss'
        elif target_advanced and round_record['together_count']:
            round_record['outcome'] = 'together'
        else:
            round_record['outcome'] = 'unresolved'
        rounds.append(round_record)
    common_rows = []
    for row in cooccurrences.values():
        row['dates'].reverse()
        row.update(count=len(row['dates']), last_date=row['dates'][0]['date'])
        common_rows.append(row)
    common_rows.sort(key=lambda row: row['code'])
    common_rows.sort(key=lambda row: (row['count'], row['last_date']), reverse=True)
    results = {}
    for outcome in ('wins', 'losses'):
        result = []
        for rival in opponents.values():
            evidence = list(reversed(rival[outcome]))
            if evidence:
                result.append({'code': rival['code'], 'name': rival['name'], 'market': rival['market'], 'count': len(evidence), 'last_date': evidence[0]['next_date'], 'rounds': evidence, 'verification': 'pending'})
        result.sort(key=lambda row: row['code'])
        result.sort(key=lambda row: (row['count'], row['last_date']), reverse=True)
        results[outcome] = result
    comparable = [row for row in rounds if row['peer_count'] and row['status'] == 'compared']
    pending = [row for row in rounds if row['peer_count'] and row['status'] != 'compared']
    cutoff = next((row for row in reversed(pending) if row['status'] == 'cutoff'), None)
    next_result_date = cutoff['next_trading_date'] if cutoff else None
    empty_reasons = {}
    for outcome, title in (('wins', '赢过'), ('losses', '输给')):
        if results[outcome]:
            empty_reasons[outcome] = ''
        elif not target_days:
            empty_reasons[outcome] = '已收录数据中没有本票的涨停记录，无法比较胜负。'
        elif not any((row['peer_count'] for row in rounds)):
            empty_reasons[outcome] = '本票涨停日中未发现同组同板数的对手，暂无竞争记录。'
        elif cutoff:
            next_label = f'{next_result_date} 的结果' if next_result_date else '下一交易日的结果'
            empty_reasons[outcome] = f"本票最后在 {cutoff['date']} 收录为 {cutoff['boards']} 板；{cutoff['boards']} 进 {cutoff['boards'] + 1} 需要查看{next_label}，超出当前数据收录范围。已收录数据中尚无{title}对手的记录。"
        elif pending:
            empty_reasons[outcome] = f'有 {len(pending)} 轮下一交易日数据未确认；已比较轮次中暂无{title}对手的记录。'
        elif outcome == 'losses' and comparable and all((row['target_next_boards'] == row['boards'] + 1 for row in comparable)):
            empty_reasons[outcome] = f'已收录数据可比较的 {len(comparable)} 轮中，本票均晋级，暂无输给对手的记录。'
        else:
            empty_reasons[outcome] = f'已比较轮次中没有符合单方晋级条件的{title}记录；共同晋级或共同未入池不计胜负。'
    return {'range_start': start, 'range_end': end, 'target_limit_days': len(target_days), 'competition': {**results, 'rounds': list(reversed(rounds)), 'win_count': sum((row['count'] for row in results['wins'])), 'loss_count': sum((row['count'] for row in results['losses'])), 'win_round_count': sum((row['outcome'] == 'win' for row in rounds)), 'loss_round_count': sum((row['outcome'] == 'loss' for row in rounds)), 'pending_rounds': len(pending), 'compared_rounds': len(comparable), 'empty_reasons': empty_reasons, 'next_result_date': next_result_date, 'verification': 'pending', 'scope_note': '同日同板数，下一交易日单方晋级；沪深主板合并，ST 记录不参与当日比较。每个晋级批次计 1 轮胜负，同一轮涉及的对手另行列出。胜负按涨停池记录比较，未入池一方待行情核实，不代表已确认断板。'}, 'cooccurrences': {'rows': common_rows, 'stock_count': len(common_rows), 'scope_note': '统计本票涨停时，同日被收录的其他股票；全市场、不限板数，每只股票每天计 1 次，不含本票。'}}


def complete_period_leaders(observations, segments, code, peer_code, end, coverage, settings, exclude_st=False, exclude_gem=False):
    """Enrich inferred pair periods using complete candidate histories only."""
    calendar = sorted(day for day in set(settings.get('calendar_dates', [])) | set(coverage) if day <= end)
    indices = {day: index for index, day in enumerate(calendar)}
    _add_period_leaders(observations, segments, code, peer_code, end, indices, exclude_st, exclude_gem)
