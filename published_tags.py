"""Install a published tag baseline while retaining this installation's own edits."""
from contextlib import closing
import json
from pathlib import Path

from lianban.research.published import apply

ROOT = Path(__file__).resolve().parent


def initialize_catalog(path):
    """Seed the public mainboard directory, retaining any existing newer cache."""
    from lianban.intraday import store as intraday
    with closing(intraday.initialize(intraday.store_path(path))) as conn, conn:
        if conn.execute('SELECT COUNT(*) FROM universe').fetchone()[0]:
            return False
        catalog = json.loads((ROOT / 'resources/mainboard-catalog.json').read_text(encoding='utf-8'))
        conn.executemany('INSERT INTO universe VALUES (?,?,?,?,?)',
                         [(row['code'], row['name'], row['market'], row['source'], row['fetched_at']) for row in catalog['rows']])
        conn.execute('INSERT OR REPLACE INTO universe_meta VALUES (?,?)', ('snapshot', json.dumps(catalog['snapshot'])))
    return True
