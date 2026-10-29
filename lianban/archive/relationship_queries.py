"""Read bounded historical facts, then delegate inference to pure rules."""
from . import relationships as rules


def _coverage(conn, end, start=None):
    clause, params = ("date BETWEEN ? AND ?", (start, end)) if start is not None else ("date<=?", (end,))
    return {row["date"]: row["status"] for row in conn.execute("SELECT date,status FROM days WHERE " + clause, params)}


def _observations(conn, clause, params, *, pair_history=False):
    columns = ["date", "code", "name", "boards"] if pair_history else ["date", "code", "name", "market", "boards"]
    order = "e.code,e.date" if pair_history else "e.date,e.code"
    cursor = conn.execute("SELECT " + ",".join("e." + key for key in columns) +
        " FROM events e JOIN days d ON d.date=e.date AND d.status='ok' WHERE " + clause + " ORDER BY " + order, params)
    # Tuple projection avoids repeatedly resolving SQLite Row field names when
    # materializing complete candidate histories for the pure calculator.
    cursor.row_factory = None
    return [dict(zip(columns, row)) for row in cursor]


def stock_relationships(conn, code, start, end, settings):
    observations = _observations(conn, "e.date BETWEEN ? AND ?", (start, end))
    return rules.stock_relationships(observations, _coverage(conn, end, start), code, start, end, settings)


def stock_pair_comparison(conn, code, peer_code, start, end, settings, exclude_st=False, exclude_gem=False):
    coverage = _coverage(conn, end)
    # Full pair histories establish runs that may start before the requested
    # range. Only periods containing a shared in-range observation are retained.
    pair = _observations(conn, "e.code IN (?,?) AND e.date<=?", (code, peer_code, end), pair_history=True)
    result = rules.stock_pair_comparison(pair, coverage, code, peer_code, start, end, settings,
                                         exclude_st, exclude_gem, include_period_leaders=False)
    segments = result["segments"]
    if not segments:
        return result
    # Discover candidates only on actual shared periods. A broad min/max
    # range would load unrelated stocks appearing between disjoint periods.
    candidates = sorted({row[0] for segment in segments for row in conn.execute(
        "SELECT DISTINCT e.code FROM events e JOIN days d ON d.date=e.date AND d.status='ok' "
        "WHERE e.date BETWEEN ? AND ? AND e.code NOT IN (?,?)",
        (segment["start"], segment["end"], code, peer_code))})
    observations = []
    for offset in range(0, len(candidates), 500):
        batch = candidates[offset:offset + 500]
        observations.extend(_observations(conn, "e.date<=? AND e.code IN (" + ",".join("?" for _ in batch) + ")", [end, *batch], pair_history=True))
    rules.complete_period_leaders(observations, segments, code, peer_code, end, coverage, settings, exclude_st, exclude_gem)
    return result
