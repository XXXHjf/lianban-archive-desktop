"""Fill missing public snapshots without replacing existing profiles or personal data."""
from contextlib import closing
import gzip
import json

from lianban.config import ROOT
from lianban.storage import initialize
from lianban.storage.settings import get_settings, set_settings
from lianban.storage.transaction import transaction

RESOURCE = ROOT / 'resources/shareholders.json.gz'


def apply(path, resource=RESOURCE):
    with gzip.open(resource, 'rt', encoding='utf-8') as handle:
        seed = json.load(handle)
    with closing(initialize(path)) as conn, transaction(conn):
        existing = {(row['code'], row['scope']) for row in conn.execute('SELECT code,scope FROM shareholder_profiles')}
        stocks = {row[0] for row in conn.execute('SELECT code FROM stocks')}
        profiles = [row for row in seed['profiles'] if row['code'] in stocks and (row['code'], row['scope']) not in existing]
        if not profiles:
            return 0
        missing = {(row['code'], row['scope']) for row in profiles}
        conn.executemany('INSERT INTO shareholder_profiles(code,scope,report_date,source,fetched_at) VALUES (?,?,?,?,?)',
            [(row['code'], row['scope'], row['report_date'], row['source'], row['fetched_at']) for row in profiles])
        conn.executemany('INSERT INTO stock_shareholders(code,scope,holder_key,holder_name,holder_type,report_date) VALUES (?,?,?,?,?,?)',
            [(row['code'], row['scope'], row['holder_key'], row['holder_name'], row['holder_type'], row['report_date'])
             for row in seed['rows'] if (row['code'], row['scope']) in missing])
        if not get_settings(conn).get('shareholder_fetched_at'):
            oldest = conn.execute('SELECT MIN(fetched_at) FROM shareholder_profiles').fetchone()[0]
            requested = conn.execute('SELECT COUNT(*) FROM (SELECT code FROM shareholder_profiles GROUP BY code HAVING COUNT(*)=2)').fetchone()[0]
            set_settings(conn, shareholder_fetched_at=oldest, shareholder_status='current', shareholder_requested=requested)
        return len(profiles)
