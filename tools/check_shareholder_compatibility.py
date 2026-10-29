"""Compare the imported shareholder feature with a fixed upstream commit, offline.

Only public seed resources and disposable databases under .build are used.
The imported code is run in separate processes; provider access is forbidden.
"""
from datetime import datetime, timezone
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REF = '2d26a92eaa46fed89346fdb2a60a8be5dab71b1a'
PROBE = '''import json
from pathlib import Path
import socket
import sys
from datetime import datetime

def deny_network(*args, **kwargs):
    raise RuntimeError('provider access forbidden in compatibility check')
socket.socket.connect = socket.socket.connect_ex = socket.create_connection = socket.getaddrinfo = deny_network
modules, path, output = map(Path, sys.argv[1:])
sys.path.insert(0, str(modules))
import database as db
import shareholders
import shareholder_seed
conn = getattr(db, 'initialize', db.connect)(path)
conn.close()
shareholder_seed.apply(path)
conn = db.connect(path)
try:
    pair = conn.execute("SELECT a.code,b.code FROM stock_shareholders a JOIN stock_shareholders b "
        "ON a.holder_key=b.holder_key AND a.code<b.code ORDER BY a.code,b.code LIMIT 1").fetchone()
    codes = list(pair)
    now = datetime(2026, 10, 29, 10, 30, tzinfo=db.TZ)
    with conn:
        conn.execute("DELETE FROM days WHERE date='2026-10-29'")
        conn.execute("DELETE FROM events WHERE date='2026-10-29'")
        conn.execute("DELETE FROM live_pools WHERE date='2026-10-29'")
    result = {'fixture_codes': codes,
              'profiles': [tuple(row) for row in conn.execute('SELECT * FROM shareholder_profiles ORDER BY code,scope')],
              'unavailable': shareholders.stock_view(conn, codes[0], now=now)}
    with conn:
        conn.execute('INSERT INTO live_pools VALUES (?,?,?,?,?,?)', ('2026-10-29',
            json.dumps([{'code': code} for code in codes]), 'synthetic', now.isoformat(), None, ''))
    result['live'] = shareholders.stock_view(conn, codes[0], now=now)
    result['alerts_live'] = shareholders.today_alerts(conn, now=now)
    result['readonly'] = shareholders.stock_view(conn, codes[0], now=now, include_live=False)
    db.save_day(conn, '2026-10-29', [{'code': code, 'name': code, 'boards': 1} for code in codes], 'synthetic')
    with conn:
        conn.execute("UPDATE days SET fetched_at=? WHERE date='2026-10-29'", (now.isoformat(),))
    result['confirmed'] = shareholders.stock_view(conn, codes[0], now=now)
    result['alerts_confirmed'] = shareholders.today_alerts(conn, now=now, include_live=False)
    output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True), encoding='utf-8')
finally:
    conn.close()
'''


def run(upstream_ref):
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT)
    commit = git('rev-parse', '--verify', '--end-of-options', upstream_ref + '^{commit}').decode().strip()
    work = ROOT / '.build' / ('shareholder-compatibility-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid4().hex)
    baseline = work / 'upstream'
    (baseline / 'resources').mkdir(parents=True)
    for name in git('ls-tree', '--name-only', commit).decode().splitlines():
        if name.endswith('.py'):
            (baseline / name).write_bytes(git('show', commit + ':' + name))
    resources = {}
    for name in ('published-tags.json', 'mainboard-catalog.json', 'shareholders.json.gz'):
        source = ROOT / 'resources' / name
        shutil.copyfile(source, baseline / 'resources' / name)
        resources[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    script = work / 'probe.py'
    script.write_text(PROBE, encoding='utf-8')
    raw = gzip.decompress((ROOT / 'resources/archive-seed.sqlite3.gz').read_bytes())
    for label, modules in (('upstream', baseline), ('current', ROOT)):
        path = work / (label + '.sqlite3')
        path.write_bytes(raw)
        result = subprocess.run([sys.executable, str(script), str(modules), str(path), str(work / (label + '.json'))],
            cwd=work, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
        (work / (label + '-stderr.txt')).write_text(result.stderr, encoding='utf-8')
        if result.returncode:
            raise RuntimeError(f'{label} failed; inspect {work}')
    old, new = [json.loads((work / (label + '.json')).read_text(encoding='utf-8')) for label in ('upstream', 'current')]
    checks = {name: old[name] == new.get(name) for name in old}
    report = {'upstream_commit': commit, 'checks': checks, 'public_resource_sha256': resources,
              'artifact_directory': str(work)}
    (work / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    for name, equal in checks.items():
        print(f'{name}: {"MATCH" if equal else "DIFFERENT"}')
    print(f'Artifacts: {work}')
    return 0 if all(checks.values()) else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream-ref', default=DEFAULT_REF)
    raise SystemExit(run(parser.parse_args().upstream_ref))
