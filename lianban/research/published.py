"""Published defaults import, kept atomic with hierarchy and version metadata."""
from contextlib import closing
import json
from lianban.config import ROOT
from lianban.storage import initialize
from lianban.storage.transaction import transaction
from lianban.storage import settings as db
from lianban.research import tag_management

def apply(path, bundle=None):
    bundle = bundle or json.loads((ROOT / 'resources/published-tags.json').read_text(encoding='utf-8'))
    with closing(initialize(path)) as conn, transaction(conn):
        settings = db.get_settings(conn)
        if settings.get('published_tags_version') == bundle['id']:
            return False
        # User overrides, exclusions, blacklist and all note tables are untouched.
        for row in bundle['stocks']:
            conn.execute('INSERT OR IGNORE INTO stocks VALUES (?,?,?,?)',
                         (row['code'], row['name'], row['market'], row['last_seen']))
            conn.execute('INSERT INTO stock_default_tags VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET '
                         'tags_json=excluded.tags_json,ths_tags_json=excluded.ths_tags_json,cls_tags_json=excluded.cls_tags_json,'
                         'source=excluded.source,fetched_at=excluded.fetched_at',
                         (row['code'], json.dumps(row['tags'], ensure_ascii=False), '[]', '[]',
                          '站主发布标签', row['last_seen']))
        previous = {node['name'].casefold(): node for node in settings.get('published_tag_hierarchy', [])}
        nodes = {node['name'].casefold(): node for node in tag_management.hierarchy(conn)}
        conflicts = []
        for node in bundle['hierarchy']:
            key = node['name'].casefold()
            current = nodes.get(key)
            if current is not None and current != previous.get(key):
                continue
            nodes[key] = dict(node)
            try:
                tag_management.validate_hierarchy(list(nodes.values()))
            except ValueError:
                # A user's pre-existing parent wins when two valid trees conflict.
                nodes[key]['parent'] = ''
                conflicts.append(node['name'])
        tag_management.install_hierarchy(conn, list(nodes.values()))
        db.set_settings(conn, default_tag_mode='concept_intersection', published_tags_version=bundle['id'],
                        published_tag_hierarchy=bundle['hierarchy'], published_tag_parent_conflicts=conflicts)
    return True
