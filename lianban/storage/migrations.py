from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from lianban.core.province import normalize_province

SCHEMA = """
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS days (
            date TEXT PRIMARY KEY, status TEXT NOT NULL, source TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
            fetched_at TEXT NOT NULL, raw_path TEXT
        );
        CREATE TABLE IF NOT EXISTS live_pools (
            date TEXT PRIMARY KEY, records_json TEXT NOT NULL, source TEXT NOT NULL,
            fetched_at TEXT NOT NULL, raw_path TEXT, note TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS stocks (
            code TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL,
            last_seen TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            date TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
            market TEXT NOT NULL, industry TEXT, boards INTEGER NOT NULL,
            close REAL, pct_change REAL, turnover REAL,
            first_time TEXT, last_time TEXT, open_times INTEGER,
            limit_up_reason TEXT, source TEXT NOT NULL,
            PRIMARY KEY (date, code)
        );
        CREATE INDEX IF NOT EXISTS events_code_date ON events(code, date);
        CREATE TABLE IF NOT EXISTS stock_industries (
            code TEXT PRIMARY KEY, industry TEXT NOT NULL,
            industry_level2 TEXT NOT NULL, industry_level3 TEXT NOT NULL,
            industry_code TEXT NOT NULL, effective_from TEXT NOT NULL,
            source_updated_at TEXT NOT NULL, source TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS company_registrations (
            code TEXT PRIMARY KEY, province TEXT NOT NULL, city TEXT NOT NULL,
            location TEXT NOT NULL, address TEXT NOT NULL,
            source TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_tag_overrides (
            code TEXT PRIMARY KEY, tags_json TEXT, revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_tag_exclusions (
            code TEXT PRIMARY KEY, tags_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tag_aliases (
            tag_key TEXT PRIMARY KEY, name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tag_nodes (
            tag_key TEXT PRIMARY KEY, name TEXT NOT NULL, parent_key TEXT
        );
        CREATE TABLE IF NOT EXISTS deleted_tags (
            tag_key TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_default_tags (
            code TEXT PRIMARY KEY, tags_json TEXT NOT NULL,
            ths_tags_json TEXT NOT NULL, cls_tags_json TEXT NOT NULL,
            source TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_notes (
            code TEXT PRIMARY KEY, content TEXT NOT NULL, revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_note_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
            occurred_at TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stock_note_entries_code_time ON stock_note_entries(code,occurred_at DESC,id DESC);
        CREATE TABLE IF NOT EXISTS stock_note_options (
            entry_id INTEGER PRIMARY KEY, note_date TEXT, deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS stock_blacklist (
            code TEXT PRIMARY KEY, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS suspension_days (
            date TEXT PRIMARY KEY, status TEXT NOT NULL, checked_at TEXT NOT NULL,
            fetched_at TEXT, source TEXT, raw_paths TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS suspension_records (
            date TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
            start TEXT NOT NULL, end TEXT, resume TEXT, reason TEXT NOT NULL,
            full_day INTEGER NOT NULL, PRIMARY KEY(date,code)
        );
    """

def initialize_connection(conn):
    """Initialize empty/legacy schema atomically; callers must supply an idle connection."""
    if conn.in_transaction:
        raise ValueError("initialization requires an idle connection")
    with transaction(conn):
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version > 1:
            raise ValueError("database schema is newer than this application")
        if version == 1:
            return conn
        for statement in SCHEMA.split(";"):
            if statement.strip():
                conn.execute(statement)
        if conn.execute("SELECT 1 FROM settings WHERE key='stock_note_history'").fetchone() is None:
            with transaction(conn):
                conn.execute("INSERT INTO stock_note_entries(code,occurred_at,content,updated_at) "
                             "SELECT n.code,n.updated_at,n.content,n.updated_at FROM stock_notes n "
                             "WHERE trim(n.content)<>'' AND NOT EXISTS (SELECT 1 FROM stock_note_entries e WHERE e.code=n.code)")
                conn.execute("INSERT OR IGNORE INTO settings VALUES ('stock_note_history','1')")
        if conn.execute("SELECT value FROM settings WHERE key='registration_storage'").fetchone() is None:
            conn.execute("PRAGMA secure_delete=ON")
            with transaction(conn):
                registrations = conn.execute("SELECT code,province FROM company_registrations").fetchall()
                conn.executemany("UPDATE company_registrations SET province=?,city='',location='',address='' WHERE code=?",
                                 [(normalize_province(row["province"]), row["code"]) for row in registrations])
                conn.execute("UPDATE settings SET value='[]' WHERE key='registration_raw_paths'")
                conn.execute("INSERT OR IGNORE INTO settings VALUES ('registration_storage','\"province-only-v1\"')")
        if conn.execute("SELECT 1 FROM settings WHERE key='tag_name_storage'").fetchone() is None:
            from lianban.research.tag_management import migrate_detached_names
            migrate_detached_names(conn)
        conn.execute("PRAGMA user_version=1")
    return conn
