from .models import Observation, ObservedCycle

def observed_cycles(all_rows: list[Observation], all_dates, available_dates, attempted, start, end) -> tuple[list[ObservedCycle], str | None]:
    """Compute observed runs without reading storage or current profile metadata."""
    indices = {day: i for i, day in enumerate(all_dates)}
    cycles = []
    for row in all_rows:
        previous = cycles[-1] if cycles else None
        can_join = bool(previous and row["boards"] == previous["boards"] + 1
                        and indices.get(row["date"], -100) == indices.get(previous["end"], 100) + 1
                        and not any(status != "ok" and previous["end"] < d < row["date"] for d, status in attempted.items()))
        if can_join:
            previous.update(end=row["date"], boards=row["boards"])
            previous["dates"].append(row["date"])
        else:
            cycles.append({"start": row["date"], "end": row["date"], "boards": row["boards"],
                           "dates": [row["date"]], "start_known": row["boards"] == 1})
    selected_dates = [d for d in all_dates if d <= end]
    selected_available = [d for d in available_dates if d <= end]
    latest = selected_available[-1] if selected_available else None
    row_by_date = {r["date"]: r for r in all_rows}
    visible_cycles = []
    for cycle in cycles:
        if cycle["end"] < start or cycle["start"] > end:
            continue
        cycle["ongoing"] = cycle["end"] == latest
        later = [d for d in selected_dates if d > cycle["end"]]
        next_day = later[0] if later else None
        gap = next_day and (attempted.get(next_day) != "ok" or any(status != "ok" and cycle["end"] < d <= next_day for d, status in attempted.items()))
        next_row = row_by_date.get(next_day)
        cycle["end_known"] = bool(next_day and not gap and (next_row is None or next_row["boards"] == 1))
        cycle["clipped"] = cycle["start"] < start or cycle["end"] > end or not cycle["start_known"]
        if cycle["clipped"]:
            cycle["note"] = "含查询区间外记录，或首板日期未收录；该周期可能不完整。"
        visible_cycles.append(cycle)
    return visible_cycles, latest
