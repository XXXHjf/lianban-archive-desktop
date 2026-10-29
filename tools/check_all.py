"""Run the complete local Python and native JavaScript development checks."""
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
    result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=ROOT)
    failures = ["Python unittest suite"] if result.returncode else []
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
    print(f"All Python and {len(scripts)} JavaScript test files passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
