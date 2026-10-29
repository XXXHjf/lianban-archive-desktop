"""SQLite connection setup. Ordinary opens never run schema or data migrations."""
import sqlite3
from pathlib import Path
from lianban.config import DEFAULT_DB

def connect(path=DEFAULT_DB):
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def initialize(path=DEFAULT_DB):
    from .migrations import initialize_connection
    conn = connect(path)
    try:
        return initialize_connection(conn)
    except BaseException:
        conn.close()
        raise
