"""SQLite minute storage; ordinary connections never run schema migrations."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from lianban.config import AppPaths
from lianban.core.clock import now_iso
from lianban.storage.transaction import transaction
from .rules import previous_close, validate_points

SCHEMA = '\n        CREATE TABLE IF NOT EXISTS sessions (\n            date TEXT NOT NULL, code TEXT NOT NULL, source TEXT NOT NULL,\n            status TEXT NOT NULL, note TEXT NOT NULL, fetched_at TEXT NOT NULL,\n            raw_path TEXT NOT NULL, previous_close REAL NOT NULL,\n            points_json TEXT NOT NULL, PRIMARY KEY(date,code)\n        );\n        CREATE TABLE IF NOT EXISTS attempts (\n            date TEXT NOT NULL, code TEXT NOT NULL, checked_at TEXT NOT NULL,\n            error TEXT NOT NULL, PRIMARY KEY(date,code)\n        );\n        CREATE TABLE IF NOT EXISTS universe (\n            code TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL,\n            source TEXT NOT NULL, fetched_at TEXT NOT NULL\n        );\n        CREATE TABLE IF NOT EXISTS universe_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n        CREATE TABLE IF NOT EXISTS session_context (\n            date TEXT NOT NULL, code TEXT NOT NULL, stock_json TEXT NOT NULL,\n            reference_basis TEXT NOT NULL, PRIMARY KEY(date,code)\n        );\n        CREATE TABLE IF NOT EXISTS auctions (\n            date TEXT NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL,\n            points_json TEXT NOT NULL, note TEXT NOT NULL, source TEXT NOT NULL,\n            fetched_at TEXT NOT NULL, raw_path TEXT NOT NULL, PRIMARY KEY(date,code)\n        );\n        CREATE TABLE IF NOT EXISTS seal_times (\n            date TEXT PRIMARY KEY, stocks_json TEXT NOT NULL, source TEXT NOT NULL,\n            fetched_at TEXT NOT NULL, raw_path TEXT NOT NULL\n        );\n    '

def store_path(archive_path):
    return AppPaths.from_archive(archive_path).intraday_db


def connect(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def initialize_connection(conn):
    """Idempotently initialize the existing schema at startup or a write boundary."""
    if conn.in_transaction:
        raise ValueError("initialization requires an idle connection")
    with transaction(conn):
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version > 1:
            raise ValueError("minute database schema is newer than this application")
        if version == 0:
            for statement in SCHEMA.split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.execute("PRAGMA user_version=1")
    return conn


def initialize(path):
    conn = connect(path)
    try:
        return initialize_connection(conn)
    except Exception:
        conn.close()
        raise


def save_session(conn, event, points, source, raw_path):
    status, note = validate_points(points, event)
    prior = conn.execute("SELECT status,points_json FROM sessions WHERE date=? AND code=?", (event["date"], event["code"])).fetchone()
    if prior and prior["status"] == "ok" and status != "ok":
        return False
    if prior and not {p["time"] for p in json.loads(prior["points_json"])}.issubset({p["time"] for p in points}):
        return False
    with conn:
        conn.execute("""INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET
            source=excluded.source,status=excluded.status,note=excluded.note,fetched_at=excluded.fetched_at,
            raw_path=excluded.raw_path,previous_close=excluded.previous_close,points_json=excluded.points_json""",
            (event["date"], event["code"], source, status, note, now_iso(), str(raw_path),
             previous_close(event), json.dumps(points, ensure_ascii=False, allow_nan=False)))
        conn.execute("DELETE FROM attempts WHERE date=? AND code=?", (event["date"], event["code"]))
        conn.execute("INSERT INTO session_context VALUES (?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET stock_json=excluded.stock_json,reference_basis=excluded.reference_basis",
                     (event["date"], event["code"], json.dumps(event, ensure_ascii=False, allow_nan=False), event.get("reference_basis", "当日收盘价和涨幅推算")))
    return True


def save_error(conn, day, code, message):
    with conn:
        conn.execute("INSERT INTO attempts VALUES (?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error",
                     (day, code, now_iso(), str(message)))


def _cached(archive_path, *, day=None, code=None, detail=False):
    path = store_path(archive_path)
    if not path.is_file():
        return {}, {}
    # Read-only: visitors never create a cache, start collection or alter data.
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        where, params = [], []
        for field, value in (("date", day), ("code", code)):
            if value is not None:
                where.append(f"{field}=?")
                params.append(value)
        clause = " WHERE " + " AND ".join(where) if where else ""
        fields = "*" if detail else "date,code,status,source,json_array_length(points_json) AS point_count"
        sessions = {(r["date"], r["code"]): dict(r) for r in conn.execute(f"SELECT {fields} FROM sessions" + clause, params)}
        errors = {(r["date"], r["code"]): r["error"] for r in conn.execute("SELECT * FROM attempts" + clause, params)}
    return sessions, errors


def catalog(archive_path):
    path = store_path(archive_path)
    if not path.is_file():
        return []
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='universe'").fetchone():
            return []
        return [dict(row) for row in conn.execute("SELECT * FROM universe ORDER BY code")]


def auction_view(archive_path, day, code):
    missing = {"status": "unchecked", "points": [], "note": "尚未核查开盘竞价数据"}
    path = store_path(archive_path)
    if not path.is_file():
        return missing
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='auctions'").fetchone():
            return missing
        row = conn.execute("SELECT * FROM auctions WHERE date=? AND code=?", (day, code)).fetchone()
        if row is None:
            return missing
        result = dict(row)
        result["points"] = json.loads(result.pop("points_json"))
        result.pop("raw_path", None)
        return result
