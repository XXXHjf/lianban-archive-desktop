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
        existing = {(row['code'], row['scope']): dict(row) for row in conn.execute(
            'SELECT code,scope,report_date,ratio_checked FROM shareholder_profiles')}
        stocks = {row[0] for row in conn.execute('SELECT code FROM stocks')}
        profiles = [row for row in seed['profiles'] if row['code'] in stocks and (row['code'], row['scope']) not in existing]
        missing = {(row['code'], row['scope']) for row in profiles}
        conn.executemany('INSERT INTO shareholder_profiles(code,scope,report_date,source,fetched_at,ratio_checked) VALUES (?,?,?,?,?,?)',
            [(row['code'], row['scope'], row['report_date'], row['source'], row['fetched_at'], row.get('ratio_checked', 0)) for row in profiles])
        conn.executemany('INSERT INTO stock_shareholders(code,scope,holder_key,holder_name,holder_type,report_date,holding_ratio) VALUES (?,?,?,?,?,?,?)',
            [(row['code'], row['scope'], row['holder_key'], row['holder_name'], row['holder_type'], row['report_date'], row.get('holding_ratio'))
             for row in seed['rows'] if (row['code'], row['scope']) in missing])
        by_profile = {}
        for row in seed['rows']:
            by_profile.setdefault((row['code'], row['scope']), []).append(row)
        for profile in seed['profiles']:
            key = profile['code'], profile['scope']
            old = existing.get(key)
            if not old or old['ratio_checked'] or old['report_date'] != profile['report_date'] or not profile.get('ratio_checked'):
                continue
            records = by_profile.get(key, [])
            keys = {row[0] for row in conn.execute('SELECT holder_key FROM stock_shareholders WHERE code=? AND scope=?', key)}
            if keys != {row['holder_key'] for row in records}:
                continue
            conn.executemany('UPDATE stock_shareholders SET holding_ratio=? WHERE code=? AND scope=? AND holder_key=?',
                             [(row.get('holding_ratio'), *key, row['holder_key']) for row in records])
            conn.execute('UPDATE shareholder_profiles SET ratio_checked=1 WHERE code=? AND scope=?', key)
        controls = {row[0] for row in conn.execute('SELECT code FROM stock_control_profiles')}
        additions = {row['code'] for row in seed.get('control_profiles', []) if row['code'] in stocks and row['code'] not in controls}
        conn.executemany('INSERT INTO stock_control_profiles(code,source,fetched_at) VALUES (?,?,?)',
                         [(row['code'], row['source'], row['fetched_at']) for row in seed.get('control_profiles', []) if row['code'] in additions])
        conn.executemany('INSERT INTO stock_control_owners VALUES (?,?,?,?,?,?,?,?)',
                         [(row['code'], row['kind'], row['holder_key'], row['holder_name'], row['holder_type'], row['via_name'], row['source_url'], row['fetched_at'])
                          for row in seed.get('control_rows', []) if row['code'] in additions and row['kind'] in ('controller', 'actual_controller')])
        conn.executemany('INSERT OR IGNORE INTO subsidiary_profiles(code,disclosure_date,companies_json,source_url,fetched_at,attempted_at) VALUES (?,?,?,?,?,?)',
                         [(row['code'], row['disclosure_date'], row['companies_json'], row['source_url'], row['fetched_at'], row['attempted_at'])
                          for row in seed.get('subsidiaries', []) if row['code'] in stocks])
        if not get_settings(conn).get('shareholder_fetched_at'):
            oldest = conn.execute('SELECT MIN(fetched_at) FROM shareholder_profiles').fetchone()[0]
            requested = conn.execute('SELECT COUNT(*) FROM (SELECT code FROM shareholder_profiles GROUP BY code HAVING COUNT(*)=2)').fetchone()[0]
            set_settings(conn, shareholder_fetched_at=oldest, shareholder_status='current', shareholder_requested=requested)
        return len(profiles)
