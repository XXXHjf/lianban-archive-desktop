from __future__ import annotations
import json
import re
from lianban.core.clock import TZ, now_iso
from lianban.storage.transaction import transaction
from contextlib import nullcontext
from lianban.storage.settings import get_settings

def save_default_tags(conn, records, source):
    """Keep verified defaults separate from every user edit and historical fact."""
    with transaction(conn):
        for row in records:
            conn.execute("INSERT INTO stock_default_tags VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET "
                         "tags_json=excluded.tags_json,ths_tags_json=excluded.ths_tags_json,"
                         "cls_tags_json=excluded.cls_tags_json,source=excluded.source,fetched_at=excluded.fetched_at",
                         (row["code"], json.dumps(row["tags"], ensure_ascii=False),
                          json.dumps(row["ths_tags"], ensure_ascii=False), json.dumps(row["cls_tags"], ensure_ascii=False),
                          source, row["fetched_at"]))


def default_tag_map(conn, codes, industries):
    if get_settings(conn).get("default_tag_mode") != "concept_intersection":
        return {code: {"tags": [industry] if industry else [], "source": "申万一级行业", "fetched_at": None}
                for code, industry in industries.items()}
    return {r["code"]: {"tags": json.loads(r["tags_json"]), "source": r["source"], "fetched_at": r["fetched_at"]}
            for r in conn.execute("SELECT * FROM stock_default_tags WHERE code IN (" +
                                  ",".join("?" for _ in codes) + ")", codes)} if codes else {}


def effective_stock_tags(custom, defaults, excluded=(), merge_defaults=False):
    """Keep user spellings/order first, then append distinct current defaults."""
    if not merge_defaults:
        return list(custom if custom is not None else defaults)
    hidden = {tag.casefold() for tag in excluded}
    result, seen = [], set()
    for tag in (custom or []):
        if tag.casefold() not in seen:
            result.append(tag)
            seen.add(tag.casefold())
    for tag in defaults:
        key = tag.casefold()
        if key not in hidden and key not in seen:
            result.append(tag)
            seen.add(key)
    return result


def get_tag_aliases(conn):
    return {r["tag_key"]: r["name"] for r in conn.execute("SELECT * FROM tag_aliases")}


def get_deleted_tag_keys(conn):
    return {row[0] for row in conn.execute("SELECT tag_key FROM deleted_tags")}


def named_stock_tags(tags, aliases, deleted=()):
    result, seen = [], set()
    for tag in tags:
        name = aliases.get(tag.casefold(), tag)
        if name.casefold() not in deleted and name.casefold() not in seen:
            result.append(name)
            seen.add(name.casefold())
    return result


def rewrite_tag_names(conn, names):
    """Materialize current names without reserving the previous spellings.

    Renamed default memberships become personal labels, with their original
    source names excluded on those stocks. Provider refreshes cannot undo the
    rename, while new uses of an old name stay independent. The caller owns
    the transaction and global revision; raw provider records stay intact.
    """
    industries = {r["code"]: r["industry"] for r in conn.execute("SELECT code,industry FROM stock_industries")}
    codes = [r[0] for r in conn.execute("SELECT code FROM stocks")]
    defaults = default_tag_map(conn, codes, industries)
    overrides = {r["code"]: r for r in conn.execute("SELECT * FROM stock_tag_overrides")}
    exclusions = {r["code"]: json.loads(r["tags_json"]) for r in conn.execute("SELECT * FROM stock_tag_exclusions")}
    merge = get_settings(conn).get("default_tag_mode") == "concept_intersection"
    for code in codes:
        override = overrides.get(code)
        custom = json.loads(override["tags_json"]) if override and override["tags_json"] is not None else None
        source = defaults.get(code, {}).get("tags", [])
        hidden = exclusions.get(code, [])
        updated = named_stock_tags(custom, names) if custom is not None else None
        excluded = list(hidden)
        if merge:
            hidden_keys = {tag.casefold() for tag in hidden}
            for tag in source:
                target = names.get(tag.casefold(), tag)
                if target != tag:
                    if tag.casefold() not in hidden_keys:
                        updated = named_stock_tags((updated or []) + [target], {})
                    if tag.casefold() not in {name.casefold() for name in excluded}:
                        excluded.append(tag)
        elif custom is None and named_stock_tags(source, names) != source:
            updated = named_stock_tags(source, names)
        if updated == custom and excluded == hidden:
            continue
        conn.execute("INSERT INTO stock_tag_overrides VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json,revision=excluded.revision,updated_at=excluded.updated_at",
                     (code, json.dumps(updated, ensure_ascii=False) if updated is not None else None,
                      (override["revision"] if override else 0) + 1, now_iso()))
        conn.execute("INSERT INTO stock_tag_exclusions VALUES (?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json",
                     (code, json.dumps(excluded, ensure_ascii=False)))


def tag_alias_revision(conn):
    return get_settings(conn).get("tag_alias_revision", 0)


class TagConflictError(ValueError):
    pass


def get_stock_tags(conn, code):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    stock = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
    if stock is None:
        raise ValueError("这只股票尚未收录")
    industry = conn.execute("SELECT industry FROM stock_industries WHERE code=?", (code,)).fetchone()
    source_tag = industry[0] if industry else None
    default = default_tag_map(conn, [code], {code: source_tag}).get(code, {})
    source_tags = default.get("tags", [])
    override = conn.execute("SELECT * FROM stock_tag_overrides WHERE code=?", (code,)).fetchone()
    customized = bool(override and override["tags_json"] is not None)
    custom_tags = json.loads(override["tags_json"]) if customized else []
    hidden = conn.execute("SELECT tags_json FROM stock_tag_exclusions WHERE code=?", (code,)).fetchone()
    excluded = json.loads(hidden[0]) if hidden else []
    merge_defaults = get_settings(conn).get("default_tag_mode") == "concept_intersection"
    aliases = get_tag_aliases(conn)
    deleted = get_deleted_tag_keys(conn)
    return {"code": code, "name": stock["name"], "source_tag": source_tag,
            "source_tags": named_stock_tags(source_tags, aliases, deleted), "tags_source": default.get("source"), "tags_as_of": default.get("fetched_at"),
            "custom_tags": named_stock_tags(custom_tags, aliases, deleted), "excluded_tags": excluded, "merge_defaults": merge_defaults,
            "tag_alias_revision": tag_alias_revision(conn),
            "tags": named_stock_tags(effective_stock_tags(custom_tags if customized else None, source_tags, excluded, merge_defaults), aliases, deleted),
            "customized": customized, "revision": override["revision"] if override else 0,
            "blacklisted": conn.execute("SELECT 1 FROM stock_blacklist WHERE code=?", (code,)).fetchone() is not None}


def save_stock_tags(conn, code, tags, revision, use_source=False, alias_revision=None, *, _commit=True):
    current = get_stock_tags(conn, code)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise ValueError("标签版本无效，请重新打开编辑窗口")
    if revision != current["revision"]:
        raise TagConflictError("标签已在其他窗口修改，请重新打开后编辑")
    if alias_revision is not None and (type(alias_revision) is not int or alias_revision != current["tag_alias_revision"]):
        raise TagConflictError("标签已全局改名或合并，请重新打开标签窗口")
    if not isinstance(use_source, bool):
        raise ValueError("标签来源选项无效")
    limit = max(20, len(current["tags"]), len(current["source_tags"]) + (20 if current["merge_defaults"] else 0))
    if not isinstance(tags, list) or len(tags) > limit:
        raise ValueError(f"每只股票最多保留 {limit} 个标签")
    clean, seen = [], set()
    for tag in tags:
        if not isinstance(tag, str):
            raise ValueError("标签必须是文字")
        tag = tag.strip()
        if not tag or len(tag) > 30 or any(ord(char) < 32 or ord(char) == 127 for char in tag):
            raise ValueError("标签需为 1 至 30 个字符")
        key = tag.casefold()
        if key not in seen:
            seen.add(key)
            clean.append(tag)
    aliases = get_tag_aliases(conn)
    clean = named_stock_tags(clean, aliases)
    deleted = get_deleted_tag_keys(conn)
    if not use_source and any(tag.casefold() in deleted for tag in clean):
        raise ValueError("该标签已被整体删除，请使用其他标签名称")
    excluded = []
    if current["merge_defaults"] and not use_source:
        source = default_tag_map(conn, [code], {}).get(code, {}).get("tags", [])
        source_keys = {tag.casefold() for tag in current["source_tags"]}
        manual_keys = {tag.casefold() for tag in current["custom_tags"]}
        selected = {tag.casefold() for tag in clean}
        raw_source_keys = {tag.casefold() for tag in source}
        excluded = [tag for tag in current["excluded_tags"] if tag.casefold() not in raw_source_keys and aliases.get(tag.casefold(), tag).casefold() not in selected]
        excluded += [tag for tag in source if aliases.get(tag.casefold(), tag).casefold() not in selected]
        clean = [tag for tag in clean if tag.casefold() not in source_keys or tag.casefold() in manual_keys]
        if len(clean) > max(20, len(current["custom_tags"])):
            raise ValueError("每只股票最多添加 20 个自定义标签")
    payload = None if use_source else json.dumps(clean, ensure_ascii=False)
    with (transaction(conn) if _commit else nullcontext()):
        if not conn.in_transaction:
            conn.execute("BEGIN IMMEDIATE")
        if tag_alias_revision(conn) != current["tag_alias_revision"]:
            raise TagConflictError("标签已全局改名或合并，请重新打开标签窗口")
        cursor = conn.execute("INSERT INTO stock_tag_overrides VALUES (?,?,?,?) "
                              "ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json, "
                              "revision=excluded.revision, updated_at=excluded.updated_at "
                              "WHERE stock_tag_overrides.revision=?",
                              (code, payload, revision + 1, now_iso(), revision))
        if cursor.rowcount != 1:
            raise TagConflictError("标签已在其他窗口修改，请重新打开后编辑")
        conn.execute("INSERT INTO stock_tag_exclusions VALUES (?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json",
                     (code, json.dumps(excluded, ensure_ascii=False)))
    return get_stock_tags(conn, code)
