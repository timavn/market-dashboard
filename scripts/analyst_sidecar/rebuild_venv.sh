#!/usr/bin/env bash
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_PYTHON="${ANALYST_BOOTSTRAP_PYTHON:-/Users/timsmith/.local/bin/python3.11}"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:6951 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Refusing to rebuild while The Analyst sidecar is listening on port 6951." >&2
  exit 1
fi
if [[ ! -x "$BOOTSTRAP_PYTHON" ]]; then
  echo "Python 3.11 is required at $BOOTSTRAP_PYTHON (override with ANALYST_BOOTSTRAP_PYTHON)." >&2
  exit 1
fi

build_dir="$(mktemp -d "${SIDECAR_DIR}/.venv-build.XXXXXX")"
archive_dir="${SIDECAR_DIR}/.venv.archived-$(date -u +%Y%m%dT%H%M%SZ)"
cleanup_build_dir() {
  if [[ -d "$build_dir" ]]; then
    rm -rf -- "$build_dir"
  fi
}
trap cleanup_build_dir EXIT

"$BOOTSTRAP_PYTHON" -m venv "$build_dir"
"$build_dir/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$build_dir/bin/python" -m pip install --disable-pip-version-check -r "$SIDECAR_DIR/requirements.txt"
"$build_dir/bin/python" - "$build_dir" <<'PY'
import os
import sys

expected = os.path.realpath(sys.argv[1])
if os.path.realpath(sys.prefix) != expected:
    raise SystemExit(f"runtime prefix drift: {sys.prefix} != {expected}")
import fastembed
import fitz
import httpx
import mcp
import openbb_core
import uvicorn
for module in (fastembed, fitz, httpx, mcp, openbb_core, uvicorn):
    if not os.path.realpath(module.__file__).startswith(expected + os.sep):
        raise SystemExit(f"dependency drift: {module.__name__} resolved to {module.__file__}")
PY

if [[ -e "$SIDECAR_DIR/.venv" ]]; then
  mv "$SIDECAR_DIR/.venv" "$archive_dir"
fi
if ! mv "$build_dir" "$SIDECAR_DIR/.venv"; then
  if [[ -d "$archive_dir" && ! -e "$SIDECAR_DIR/.venv" ]]; then
    mv "$archive_dir" "$SIDECAR_DIR/.venv"
  fi
  echo "Runtime promotion failed; the previous environment was restored when possible." >&2
  exit 1
fi
if [[ -d "$archive_dir" ]]; then
  rm -rf -- "$archive_dir"
fi

echo "The Analyst runtime is ready at $SIDECAR_DIR/.venv/bin/python"
