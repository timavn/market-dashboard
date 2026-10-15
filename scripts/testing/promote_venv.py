"""Promote a venv without moving it: installed entrypoints contain absolute paths."""

import os
from pathlib import Path
import subprocess
import sys
import uuid
from datetime import datetime, timezone


def promote_venv(runtime, active):
    runtime = Path(runtime).resolve(strict=True)
    active = Path(os.path.abspath(active))
    if active.name != ".venv" or runtime.parent != (active.parent / ".venv.runtimes").resolve():
        raise ValueError("Runtime must be built inside the sidecar's .venv.runtimes directory.")
    if active.exists() and not active.is_dir():
        raise ValueError("Refusing to replace an active runtime that is not a directory.")
    subprocess.run([
        str(runtime / "bin/python"), "-c",
        "import os,sys; sys.exit(0 if os.path.realpath(sys.prefix) == sys.argv[1] else 1)",
        str(runtime),
    ], check=True, timeout=15)

    suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    archive = active.with_name(f".venv.archived-{suffix}")
    pending = active.with_name(f".venv.next-{suffix}")
    os.symlink(str(runtime), pending, target_is_directory=True)
    archived = False
    try:
        if active.exists() or active.is_symlink():
            os.rename(active, archive)
            archived = True
        os.replace(pending, active)
    except BaseException:
        if archived and not active.exists() and not active.is_symlink():
            os.rename(archive, active)
        raise
    finally:
        pending.unlink(missing_ok=True)
    return archive if archived else None


if __name__ == "__main__":
    previous = promote_venv(*sys.argv[1:])
    if previous is not None:
        print(f"Archived previous runtime at {previous}")
