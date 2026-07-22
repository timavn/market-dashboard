#!/usr/bin/env bash
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_PYTHON="${SIDECAR_BOOTSTRAP_PYTHON:-$(command -v python3)}"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Refusing to rebuild while the sidecar is listening on port 8765. Run npm run dev:stop first." >&2
  exit 1
fi

build_dir="$(mktemp -d "${SIDECAR_DIR}/.venv-build.XXXXXX")"
archive_dir="${SIDECAR_DIR}/.venv.archived-$(date -u +%Y%m%dT%H%M%SZ)"

echo "Building isolated sidecar runtime with ${BOOTSTRAP_PYTHON}"
"$BOOTSTRAP_PYTHON" -m venv "$build_dir"
"$build_dir/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$build_dir/bin/python" -m pip install --disable-pip-version-check -r "$SIDECAR_DIR/requirements.txt"

"$build_dir/bin/python" - "$build_dir" <<'PY'
import os
import sys

expected = os.path.realpath(sys.argv[1])
if os.path.realpath(sys.prefix) != expected:
    raise SystemExit(f"runtime prefix drift: {sys.prefix} != {expected}")
import fastapi  # noqa: F401
import ib_insync  # noqa: F401
import uvicorn  # noqa: F401
for module in (fastapi, ib_insync, uvicorn):
    if not os.path.realpath(module.__file__).startswith(expected + os.sep):
        raise SystemExit(f"dependency drift: {module.__name__} resolved to {module.__file__}")
PY

if [[ -e "$SIDECAR_DIR/.venv" ]]; then
  mv "$SIDECAR_DIR/.venv" "$archive_dir"
  echo "Archived previous runtime at ${archive_dir}"
fi

if ! mv "$build_dir" "$SIDECAR_DIR/.venv"; then
  if [[ -d "$archive_dir" && ! -e "$SIDECAR_DIR/.venv" ]]; then
    mv "$archive_dir" "$SIDECAR_DIR/.venv"
  fi
  echo "Runtime promotion failed; the prior runtime was restored when possible." >&2
  exit 1
fi

echo "Sidecar runtime promoted: ${SIDECAR_DIR}/.venv/bin/python"
"$SIDECAR_DIR/.venv/bin/python" -c 'import sys, fastapi, ib_insync, uvicorn; print(sys.executable); print(sys.prefix)'
