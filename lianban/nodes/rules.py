"""Pure node rules; no storage or transport dependencies."""
from decimal import Decimal


def unique_anchor(rows):
    if not rows:
        return None
    highest = max(row['boards'] for row in rows)
    leaders = [row for row in rows if row['boards'] == highest]
    return leaders[0] if len(leaders) == 1 else None


def node_kind(opening, previous_close):
    opening, previous_close = Decimal(str(opening)), Decimal(str(previous_close))
    if not opening.is_finite() or not previous_close.is_finite() or min(opening, previous_close) <= 0:
        raise ValueError('开盘和昨收必须为有效正价格')
    return 'low_open' if opening <= previous_close else 'break'


def survivors(members, initial_height, sessions):
    """Stop at a coverage gap; never use a later rebound to restore a member."""
    alive = set(members)
    height = initial_height
    for rows in sessions:
        if rows is None:
            return alive, height, True
        height += 1
        promoted = {row['code'] for row in rows if row['boards'] == height}
        alive &= promoted
    return alive, height, False
