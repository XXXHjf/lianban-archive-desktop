"""Rebuild the distribution integrity manifest after an intentional release."""
from pathlib import Path
import hashlib
import json
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from setup_shared import runtime_files
from tools.check_frontend_build import verify_frontend_build
if (ROOT/'frontend').is_dir():
    verify_frontend_build(ROOT)
baseline=json.loads((ROOT/'SOURCE_BASELINE.json').read_text(encoding='utf-8'))
seed=json.loads((ROOT/'resources/archive-seed.sqlite3.json').read_text(encoding='utf-8'))
dependencies=dict(line.strip().split('==') for line in (ROOT/'requirements.txt').read_text().splitlines() if line.strip())
code=runtime_files(ROOT)
maintained={'upstream': {'manifest':'SOURCE_BASELINE.json',
                       'source_commit':baseline['source_commit'],
                       'sha256':hashlib.sha256((ROOT/'SOURCE_BASELINE.json').read_bytes()).hexdigest()},
            'identity_sha256':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sorted(code)}}
(ROOT/'BUILD_BASELINE.json').write_text(json.dumps(maintained,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
names=set(code)
names.update(str(p.relative_to(ROOT)).replace('\\','/') for p in (ROOT/'web').rglob('*') if p.is_file())
names.update(str(p.relative_to(ROOT)).replace('\\','/') for directory in ('vendor','resources','certs') for p in (ROOT/directory).rglob('*') if p.is_file())
names.update(['install-online.ps1','VERSION.json','launcher.ps1','install.cmd','start_demo.cmd','stop_demo.cmd','verify.cmd','SOURCE_BASELINE.json','BUILD_BASELINE.json','requirements.txt'])
hashes={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sorted(names)}
bundle={'id':hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()[:16],
        'runtime':'vendor/python-3.13.16-embed-amd64.zip',
        'wheels':sorted(n for n in names if n.endswith('.whl')), 'dependencies':dependencies,
        'seed':'resources/archive-seed.sqlite3.gz','seed_database_sha256':seed['database_sha256'],
        'sha256':hashes}
(ROOT/'BUNDLE.json').write_text(json.dumps(bundle,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
print('Bundle',bundle['id'],'verified files',len(hashes))
