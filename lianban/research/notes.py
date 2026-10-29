from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from datetime import date, datetime
NOTE_DATE_UNSET = object()

class NoteConflictError(ValueError):
    pass


def get_stock_note(conn, code):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    stock = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
    if stock is None:
        raise ValueError("这只股票尚未收录")
    note = conn.execute("SELECT * FROM stock_notes WHERE code=?", (code,)).fetchone()
    entries = [dict(row) for row in conn.execute(
        "SELECT e.id,e.occurred_at,e.content,e.updated_at,COALESCE(o.note_date,substr(e.occurred_at,1,10)) AS note_date "
        "FROM stock_note_entries e LEFT JOIN stock_note_options o ON o.entry_id=e.id "
        "WHERE e.code=? AND o.deleted_at IS NULL ORDER BY e.occurred_at DESC,e.id DESC", (code,))]
    return {"code": code, "name": stock["name"], "content": note["content"] if note else "",
            "revision": note["revision"] if note else 0, "updated_at": note["updated_at"] if note else None,
            "entries": entries, "latest_entry_id": entries[0]["id"] if entries else None}


def note_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:Z|[+-][0-9]{2}:[0-9]{2})?", value):
        raise ValueError("请输入有效的备注时间")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (stamp if stamp.tzinfo else stamp.replace(tzinfo=TZ)).astimezone(TZ).isoformat(timespec="seconds")
    except (ValueError, OverflowError):
        raise ValueError("请输入有效的备注时间") from None


def latest_stock_note_content(conn, code):
    latest = conn.execute("SELECT e.content FROM stock_note_entries e LEFT JOIN stock_note_options o ON o.entry_id=e.id "
                          "WHERE e.code=? AND o.deleted_at IS NULL ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1", (code,)).fetchone()
    return latest["content"] if latest else ""


def save_stock_note(conn, code, content, revision, *, entry_id=None, occurred_at=None, new_entry=False, note_date=NOTE_DATE_UNSET):
    current = get_stock_note(conn, code)
    if type(revision) is not int or revision < 0:
        raise ValueError("备注版本无效，请重新打开备注窗口")
    if revision != current["revision"]:
        raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
    if not isinstance(content, str):
        raise ValueError("备注必须是文字")
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    if len(content) > 5000:
        raise ValueError("备注最多 5000 个字符")
    if any(ord(char) < 32 and char not in "\n\t" or ord(char) == 127 for char in content):
        raise ValueError("备注包含不支持的控制字符")
    if not content.strip():
        content = ""
    if type(new_entry) is not bool or entry_id is not None and (type(entry_id) is not int or entry_id < 1):
        raise ValueError("备注时间节点无效，请重新打开备注窗口")
    if new_entry and entry_id is not None:
        raise ValueError("新增备注不能同时选择历史时间节点")
    selected = None
    if not new_entry:
        selected = next((entry for entry in current["entries"] if entry["id"] == entry_id), None) if entry_id is not None else next(iter(current["entries"]), None)
        if entry_id is not None and selected is None:
            raise ValueError("这条历史备注不存在，请重新打开备注窗口")
    stamp = note_timestamp(occurred_at) if occurred_at is not None else selected["occurred_at"] if selected else now_iso()
    if note_date is not NOTE_DATE_UNSET:
        note_date = "" if note_date is None else note_date
        if not isinstance(note_date, str) or note_date and not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", note_date):
            raise ValueError("备注日期应为年月日，也可以留空")
        if note_date:
            try:
                date.fromisoformat(note_date)
            except ValueError:
                raise ValueError("请输入有效的备注日期") from None
            if not selected or note_date != selected["occurred_at"][:10]:
                stamp = note_date + now_iso()[10:]
    updated_at = now_iso()
    with transaction(conn):
        cursor = conn.execute("INSERT INTO stock_notes VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET "
                              "content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at "
                              "WHERE stock_notes.revision=?", (code, current["content"], revision + 1, updated_at, revision))
        if cursor.rowcount != 1:
            raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
        if selected:
            conn.execute("UPDATE stock_note_entries SET content=?,occurred_at=?,updated_at=? WHERE id=? AND code=?",
                         (content, stamp, updated_at, selected["id"], code))
        else:
            inserted = conn.execute("INSERT INTO stock_note_entries(code,occurred_at,content,updated_at) VALUES (?,?,?,?)",
                                    (code, stamp, content, updated_at))
            entry_id = inserted.lastrowid
        if note_date is not NOTE_DATE_UNSET:
            conn.execute("INSERT INTO stock_note_options(entry_id,note_date) VALUES (?,?) "
                         "ON CONFLICT(entry_id) DO UPDATE SET note_date=excluded.note_date", (selected["id"] if selected else entry_id, note_date))
        conn.execute("UPDATE stock_notes SET content=? WHERE code=?", (latest_stock_note_content(conn, code), code))
    return get_stock_note(conn, code)


def change_stock_note_entry(conn, code, entry_id, revision, action):
    current = get_stock_note(conn, code)
    if type(revision) is not int or revision < 0:
        raise ValueError("备注版本无效，请重新打开备注窗口")
    if revision != current["revision"]:
        raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
    if action not in ("delete", "restore") or type(entry_id) is not int or entry_id < 1:
        raise ValueError("备注操作或时间节点无效")
    entry = conn.execute("SELECT e.id,o.deleted_at FROM stock_note_entries e LEFT JOIN stock_note_options o ON o.entry_id=e.id "
                         "WHERE e.id=? AND e.code=?", (entry_id, code)).fetchone()
    if entry is None or (action == "delete") == bool(entry["deleted_at"]):
        raise ValueError("这条备注的状态已变化，请重新读取后操作")
    with transaction(conn):
        cursor = conn.execute("UPDATE stock_notes SET revision=?,updated_at=? WHERE code=? AND revision=?",
                              (revision + 1, now_iso(), code, revision))
        if cursor.rowcount != 1:
            raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
        conn.execute("INSERT INTO stock_note_options(entry_id,deleted_at) VALUES (?,?) "
                     "ON CONFLICT(entry_id) DO UPDATE SET deleted_at=excluded.deleted_at", (entry_id, now_iso() if action == "delete" else None))
        conn.execute("UPDATE stock_notes SET content=? WHERE code=?", (latest_stock_note_content(conn, code), code))
    return get_stock_note(conn, code)
