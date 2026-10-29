"""Internal archive facts; current research metadata is deliberately absent."""
from typing import Literal, TypedDict

CoverageStatus = Literal["ok", "empty", "failed", "unknown"]

class Observation(TypedDict):
    date: str
    code: str
    name: str
    market: str
    boards: int

class ObservedCycle(TypedDict):
    start: str
    end: str
    boards: int
    dates: list[str]
    start_known: bool
    end_known: bool
    ongoing: bool
    clipped: bool
