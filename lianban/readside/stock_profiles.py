"""Combine current company metadata, effective tags and notes for presentation."""
import json
from lianban.storage.settings import get_settings
from lianban.research.tags import default_tag_map, get_tag_aliases, get_deleted_tag_keys, named_stock_tags, effective_stock_tags

def enrich_stock_profiles(conn, rows):
    codes = list({row["code"] for row in rows})
    if not codes:
        return rows
    industries = {r["code"]: dict(r) for r in conn.execute(
        "SELECT * FROM stock_industries WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    for row in rows:
        current = industries.get(row["code"])
        if current:
            row.update(industry=current["industry"], industry_source=current["source"],
                       industry_as_of=current["fetched_at"], industry_effective_from=current["effective_from"])
    registrations = {r["code"]: dict(r) for r in conn.execute(
        "SELECT * FROM company_registrations WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    for row in rows:
        registration = registrations.get(row["code"])
        if registration:
            row.update(registered_province=registration["province"],
                       registration_source=registration["source"], registration_as_of=registration["fetched_at"])
    overrides = {r["code"]: dict(r) for r in conn.execute(
        "SELECT * FROM stock_tag_overrides WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    defaults = default_tag_map(conn, codes, {row["code"]: row.get("industry") for row in rows})
    merge_defaults = get_settings(conn).get("default_tag_mode") == "concept_intersection"
    exclusions = {r["code"]: json.loads(r["tags_json"]) for r in conn.execute(
        "SELECT * FROM stock_tag_exclusions WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    aliases = get_tag_aliases(conn)
    deleted = get_deleted_tag_keys(conn)
    for row in rows:
        override = overrides.get(row["code"])
        customized = bool(override and override["tags_json"] is not None)
        default = defaults.get(row["code"], {})
        custom = json.loads(override["tags_json"]) if customized else None
        row.update(tags=named_stock_tags(effective_stock_tags(custom, default.get("tags", []), exclusions.get(row["code"], []), merge_defaults), aliases, deleted),
                   source_tags=named_stock_tags(default.get("tags", []), aliases, deleted), tags_source=default.get("source"),
                   tags_as_of=default.get("fetched_at"),
                   tags_customized=customized, tags_revision=override["revision"] if override else 0)
    notes = {r["code"]: r["content"] for r in conn.execute(
        "SELECT code,content FROM stock_notes WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    for row in rows:
        row["note"] = notes.get(row["code"], "")
    return rows
