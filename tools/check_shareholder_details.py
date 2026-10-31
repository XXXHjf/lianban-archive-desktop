"""Compare only user-approved public detail fields with the fixed upstream, offline.

Control relationships are display-only here. Broader matching, competition changes,
new account filters, version labels and automatic popups are intentionally excluded.
"""
from pathlib import Path
import gzip
import hashlib
import json
import shutil
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = '3f2017969cb2cee6934dbf1a63051f9c713401e9'
PROBE = '''from pathlib import Path
from contextlib import closing
import json, socket, sys
modules, path, output = map(Path, sys.argv[1:])
sys.path.insert(0, str(modules))
def deny(*args, **kwargs):
    raise RuntimeError('network forbidden during public data comparison')
socket.socket.connect = socket.socket.connect_ex = socket.create_connection = socket.getaddrinfo = deny
import database as db
import shareholder_seed, shareholders
try:
    from lianban.profiles import subsidiaries
except ImportError:
    import subsidiaries
with closing(getattr(db, 'initialize', db.connect)(path)):
    pass
shareholder_seed.apply(path)
result = {}
with closing(db.connect(path)) as conn:
    for code in ('001219', '000001', '600519'):
        data = shareholders.stock_view(conn, code, include_live=False)
        # The user rejected upstream's separate HKSCC category. Compare that
        # one display classification to the unchanged provider category.
        for scope, holders in data['own_holders'].items():
            for holder in holders:
                if holder['name'] == '香港中央结算有限公司':
                    stored = conn.execute('SELECT holder_type FROM stock_shareholders WHERE code=? AND scope=? AND holder_name=?',
                                          (code, scope, holder['name'])).fetchone()
                    holder['type'] = stored[0]
        result[code] = {'own_holders': data['own_holders'], 'profiles': data['profiles'],
                        'controls': sorted([{k: r[k] for k in ('kind','name','type','source_url')}
                                            for r in data['control_owners']], key=lambda r: (r['kind'],r['name']))}
    codes = [r[0] for r in conn.execute('SELECT code FROM subsidiary_profiles ORDER BY code')]
for code in codes:
    result['subsidiary:' + code] = subsidiaries.stock_view(path, code, refresh=False)
output.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True), encoding='utf-8')
'''


def main():
    work = ROOT / '.build' / ('approved-shareholder-details-' + uuid4().hex)
    upstream = work / 'upstream'
    (upstream / 'resources').mkdir(parents=True)
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT)
    for name in git('ls-tree', '--name-only', UPSTREAM).decode().splitlines():
        if name.endswith('.py'):
            (upstream / name).write_bytes(git('show', UPSTREAM + ':' + name))
    for name in ('published-tags.json', 'mainboard-catalog.json', 'shareholders.json.gz'):
        shutil.copyfile(ROOT / 'resources' / name, upstream / 'resources' / name)
    script = work / 'probe.py'
    script.write_text(PROBE, encoding='utf-8')
    for label, modules in (('upstream', upstream), ('current', ROOT)):
        path = work / (label + '.sqlite3')
        path.write_bytes(gzip.decompress((ROOT / 'resources/archive-seed.sqlite3.gz').read_bytes()))
        result = subprocess.run([sys.executable, str(script), str(modules), str(path), str(work / (label + '.json'))],
                                cwd=work, capture_output=True, encoding='utf-8', errors='replace', timeout=120)
        (work / (label + '-stderr.txt')).write_text(result.stderr, encoding='utf-8')
        if result.returncode:
            raise RuntimeError(f'{label} failed; inspect {work}')
    old, new = [json.loads((work / (label + '.json')).read_text(encoding='utf-8')) for label in ('upstream', 'current')]
    checks = {key: old[key] == new.get(key) for key in old}
    report = {'upstream_commit': UPSTREAM, 'checks': checks,
              'excluded_upstream_changes': ['independent HKSCC classification; retain provider category'],
              'resource_sha256': hashlib.sha256((ROOT / 'resources/shareholders.json.gz').read_bytes()).hexdigest()}
    (work / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    return 0 if all(checks.values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
