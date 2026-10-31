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

SHAREHOLDER_SCHEMA = """
    CREATE TABLE IF NOT EXISTS shareholder_profiles (
        code TEXT NOT NULL, scope TEXT NOT NULL, report_date TEXT,
        source TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(code,scope)
    );
    CREATE TABLE IF NOT EXISTS stock_shareholders (
        code TEXT NOT NULL, scope TEXT NOT NULL, holder_key TEXT NOT NULL,
        holder_name TEXT NOT NULL, holder_type TEXT NOT NULL, report_date TEXT NOT NULL,
        PRIMARY KEY(code,scope,holder_key)
    );
    CREATE INDEX IF NOT EXISTS shareholders_holder ON stock_shareholders(holder_key,code);
"""
NODE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS cycle_nodes (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, boards INTEGER NOT NULL,
        name TEXT NOT NULL, kind TEXT NOT NULL, anchor TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '', deleted_from TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cycle_node_members (
        node_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
        PRIMARY KEY(node_id,code)
    );
    CREATE TABLE IF NOT EXISTS cycle_node_exclusions (
        node_id TEXT NOT NULL, code TEXT NOT NULL, date TEXT NOT NULL,
        PRIMARY KEY(node_id,code)
    );
    CREATE TABLE IF NOT EXISTS node_openings (
        date TEXT NOT NULL, code TEXT NOT NULL, opening REAL NOT NULL,
        previous_close REAL NOT NULL, source TEXT NOT NULL, raw_path TEXT NOT NULL,
        PRIMARY KEY(date,code)
    );
    CREATE TABLE IF NOT EXISTS node_checks (
        date TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT NOT NULL, checked_at TEXT NOT NULL
    );
"""
COMPANY_PROFILE_SCHEMA = """
    CREATE TABLE IF NOT EXISTS stock_control_profiles (
        code TEXT PRIMARY KEY, source TEXT NOT NULL, fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_control_owners (
        code TEXT NOT NULL, kind TEXT NOT NULL, holder_key TEXT NOT NULL,
        holder_name TEXT NOT NULL, holder_type TEXT NOT NULL, via_name TEXT NOT NULL,
        source_url TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY(code,kind,holder_key)
    );
    CREATE TABLE IF NOT EXISTS subsidiary_profiles (
        code TEXT PRIMARY KEY, disclosure_date TEXT, companies_json TEXT,
        source_url TEXT NOT NULL DEFAULT '', fetched_at TEXT,
        attempted_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
    );
"""
SCHEMA_VERSION = 4


def initialize_connection(conn):
    """Migrate legacy/v1 databases atomically, without running migrations on ordinary opens."""
    if conn.in_transaction:
        raise ValueError("initialization requires an idle connection")
    with transaction(conn):
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise ValueError("database schema is newer than this application")
        if version < 1:
            _initialize_legacy(conn)
        if version < 2:
            for statement in SHAREHOLDER_SCHEMA.split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.execute("PRAGMA user_version=2")
        if version < 3:
            for statement in NODE_SCHEMA.split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.execute("PRAGMA user_version=3")
        if version < 4:
            if 'ratio_checked' not in {row[1] for row in conn.execute('PRAGMA table_info(shareholder_profiles)')}:
                conn.execute("ALTER TABLE shareholder_profiles ADD COLUMN ratio_checked INTEGER NOT NULL DEFAULT 0")
            if 'holding_ratio' not in {row[1] for row in conn.execute('PRAGMA table_info(stock_shareholders)')}:
                conn.execute("ALTER TABLE stock_shareholders ADD COLUMN holding_ratio REAL")
            for statement in COMPANY_PROFILE_SCHEMA.split(";"):
                if statement.strip():
                    conn.execute(statement)
            conn.execute("PRAGMA user_version=4")
    return conn


def _initialize_legacy(conn):
    """The original v0-to-v1 rules; keep their existing personal-data semantics."""
    with transaction(conn):
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
