"""Export only the owner-approved effective labels, never notes or private tables."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys


def export(source_root, destination):
    source_root = Path(source_root).resolve()
    sys.path.insert(0, str(source_root))
    import database as db
    import tag_management

    source = source_root / 'data/archive.sqlite3'
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute('BEGIN')
        stocks = [dict(row) for row in conn.execute('SELECT code,name,market,last_seen FROM stocks ORDER BY code')]
        for start in range(0, len(stocks), 500):
            db.enrich_industries(conn, stocks[start:start + 500])
        rows = [{key: row[key] for key in ('code', 'name', 'market', 'last_seen', 'tags')} for row in stocks]
        nodes = tag_management.hierarchy(conn)
    tag_management._validate_hierarchy(nodes)
    payload = {'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source_root).decode().strip(),
               'stocks': rows, 'hierarchy': nodes}
    payload['id'] = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(json.dumps({'id': payload['id'], 'stocks': len(rows), 'memberships': sum(len(row['tags']) for row in rows),
                      'hierarchy_nodes': len(nodes), 'notes_exported': 0, 'blacklist_exported': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    options = parser.parse_args()
    export(options.source_root, options.output)
