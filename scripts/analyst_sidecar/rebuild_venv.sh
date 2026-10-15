#!/usr/bin/env bash
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_PYTHON="${ANALYST_BOOTSTRAP_PYTHON:-/Users/timsmith/.local/bin/python3.11}"

assert_sidecar_stopped() {
  if ! command -v lsof >/dev/null 2>&1; then
    echo "lsof is required to verify that The Analyst sidecar is stopped." >&2
    exit 1
  fi
  if lsof -nP -iTCP:6951 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Refusing to replace a runtime while The Analyst sidecar is listening on port 6951." >&2
    exit 1
  fi
}
assert_sidecar_stopped
if [[ ! -x "$BOOTSTRAP_PYTHON" ]]; then
  echo "Python 3.11 is required at $BOOTSTRAP_PYTHON (override with ANALYST_BOOTSTRAP_PYTHON)." >&2
  exit 1
fi
"$BOOTSTRAP_PYTHON" -c 'import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] < (3, 13) else 1)'

mkdir -p "$SIDECAR_DIR/.venv.runtimes"
build_dir="$(mktemp -d "${SIDECAR_DIR}/.venv.runtimes/runtime.XXXXXX")"
cleanup_build_dir() {
  if [[ -d "$build_dir" && "$(readlink "$SIDECAR_DIR/.venv" || true)" != "$build_dir" ]]; then
    rm -rf -- "$build_dir"
  fi
}
trap cleanup_build_dir EXIT

"$BOOTSTRAP_PYTHON" -m venv "$build_dir"
"$build_dir/bin/python" -m pip install --disable-pip-version-check -r "$SIDECAR_DIR/../testing/python-bootstrap.txt"
"$build_dir/bin/python" -m pip install --disable-pip-version-check -c "$SIDECAR_DIR/constraints.txt" -r "$SIDECAR_DIR/requirements.txt"
"$build_dir/bin/python" - "$build_dir" <<'PY'
import os
import sys

expected = os.path.realpath(sys.argv[1])
if os.path.realpath(sys.prefix) != expected:
    raise SystemExit(f"runtime prefix drift: {sys.prefix} != {expected}")
import fastembed
import pymupdf as fitz
import httpx
import mcp
import openbb_core
import uvicorn
for module in (fastembed, fitz, httpx, mcp, openbb_core, uvicorn):
    if not os.path.realpath(module.__file__).startswith(expected + os.sep):
        raise SystemExit(f"dependency drift: {module.__name__} resolved to {module.__file__}")
PY

# Keep the runtime at its build path: console scripts and activation files
# embed that path. Only the conventional .venv pointer changes on promotion.
assert_sidecar_stopped
"$BOOTSTRAP_PYTHON" "$SIDECAR_DIR/../testing/promote_venv.py" "$build_dir" "$SIDECAR_DIR/.venv"

echo "The Analyst runtime is ready at $SIDECAR_DIR/.venv/bin/python"
