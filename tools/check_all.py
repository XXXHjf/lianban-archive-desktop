"""Run Vue checks, backend tests and historical frontend reference regressions."""
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    node = shutil.which("node")
    if not node:
        print("Node.js is required to run frontend checks.", file=sys.stderr)
        return 1
    npm = shutil.which('npm')
    if not npm:
        print('npm is required for Vue development checks.', file=sys.stderr)
        return 1
    failures = []
    result = subprocess.run([sys.executable, 'tools/check_frontend_build.py'], cwd=ROOT)
    if result.returncode:
        failures.append('Frontend built source inventory')
    for command in ('typecheck', 'lint', 'format:check', 'test'):
        result = subprocess.run([npm, 'run', command], cwd=ROOT / 'frontend')
        if result.returncode:
            failures.append('Vue ' + command)
    result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=ROOT)
    if result.returncode:
        failures.append('Python unittest suite')
    scripts = sorted((ROOT / "tests").glob("test_*.js"))
    if not scripts:
        print("No JavaScript test files found.", file=sys.stderr)
        return 1
    for script in scripts:
        print(f"Checking {script.relative_to(ROOT).as_posix()}", flush=True)
        result = subprocess.run([node, str(script)], cwd=ROOT)
        if result.returncode:
            failures.append(script.relative_to(ROOT).as_posix())
    if failures:
        print("Failed checks: " + ", ".join(failures), file=sys.stderr)
        return 1
    print(f"Vue typecheck/lint/tests, all Python tests and {len(scripts)} historical JavaScript reference files passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
