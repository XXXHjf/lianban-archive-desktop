from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from urllib.parse import urlsplit
REQUEST_START = "2020-01-01"
REQUEST_END = "2026-10-14"
DEFAULT_SITE_LINKS = {"author_url": "https://www.tgb.cn/blog/5894557", "feedback_url": ""}

def set_settings(conn, **values):
    with transaction(conn):
        for key, value in values.items():
            conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (key, json.dumps(value, ensure_ascii=False)))


def get_settings(conn):
    values = {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT * FROM settings")}
    values.setdefault("range_start", REQUEST_START)
    values.setdefault("range_end", REQUEST_END)
    values.setdefault("source", "免费公开涨停池")
    values.setdefault("scope_note", "数据范围以来源覆盖为准；未收录不等于未涨停。")
    values.setdefault("method_note", "连板数采用数据源字段；首板为 1。盘中触板不计为收盘涨停。")
    return values


def public_site_link(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\]", value):
        return ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            return ""
        parsed.port  # Reject malformed ports before publishing a link.
    except ValueError:
        return ""
    return value


def get_site_links(conn):
    row = conn.execute("SELECT value FROM settings WHERE key='site_links'").fetchone()
    try:
        links = json.loads(row["value"]) if row else {}
    except (TypeError, json.JSONDecodeError):
        links = {}
    if not isinstance(links, dict):
        links = {}
    return {"links": {key: public_site_link(links.get(key, default)) for key, default in DEFAULT_SITE_LINKS.items()}}


def get_announcement(conn):
    """Public display fields only; disabled drafts never leave the database."""
    row = conn.execute("SELECT value FROM settings WHERE key='site_announcement'").fetchone()
    try:
        notice = json.loads(row["value"]) if row else {}
    except (TypeError, json.JSONDecodeError):
        notice = {}
    if not isinstance(notice, dict):
        notice = {}
    content = notice.get("content")
    enabled = notice.get("enabled") is True and isinstance(content, str) and bool(content.strip())
    title = notice.get("title")
    revision = notice.get("revision")
    updated_at = notice.get("updated_at")
    return {"announcement": {"title": title[:120] if enabled and isinstance(title, str) else "",
                             "content": content[:20000] if enabled else "", "enabled": enabled,
                             "revision": revision if type(revision) is int and revision >= 0 else 0,
                             "updated_at": updated_at[:64] if isinstance(updated_at, str) else None}}
