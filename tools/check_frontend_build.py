"""Check the checked-in static UI was built from the current maintained source."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]


def verify_frontend_build(root=ROOT):
    root = Path(root)
    frontend = root / 'frontend'
    info = json.loads((root / 'web/assets/build-info.json').read_text(encoding='utf-8'))
    inputs = [*frontend.joinpath('src').rglob('*'), *frontend.joinpath('scripts').rglob('*')]
    inputs += [frontend / name for name in ('package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', '.node-version', '.npmrc')]
    actual = {path.relative_to(frontend).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in inputs if path.is_file()}
    if actual != info['source_sha256']:
        raise ValueError('Frontend source differs from generated assets; run npm run build in frontend before building manifests.')
    if info['dependencies'] != json.loads((frontend / 'package.json').read_text(encoding='utf-8'))['dependencies']:
        raise ValueError('Frontend dependency versions differ from the bundled build.')
    return info


if __name__ == '__main__':
    info = verify_frontend_build()
    print('Frontend build matches', len(info['source_sha256']), 'maintained source inputs.')
