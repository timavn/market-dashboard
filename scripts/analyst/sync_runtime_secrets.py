"""Keep the isolated Hermes profile's MCP credential in sync with its supervisor."""

import os
from pathlib import Path
import re
import tempfile


def sync_runtime_token(profile_home: Path, token: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("A supervisor-issued Analyst service token is required.")
    profile_home.mkdir(parents=True, exist_ok=True)
    destination = profile_home / ".env"
    if destination.is_symlink():
        raise ValueError("The Analyst profile environment must be a regular file.")
    previous = destination.read_text() if destination.exists() else ""
    # Only this supervisor-owned key changes; preserve the profile's other settings.
    current = re.sub(
        r"(?m)^[ \t]*(?:export[ \t]+)?ANALYST_SERVICE_TOKEN[ \t]*=.*(?:\n|$)",
        "", previous,
    )
    if current and not current.endswith("\n"):
        current += "\n"
    current += f"ANALYST_SERVICE_TOKEN={token}\n"
    fd, temporary = tempfile.mkstemp(prefix=".env-runtime-", dir=profile_home)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(current)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    sync_runtime_token(
        Path(os.environ.get("ANALYST_HERMES_HOME", str(Path.home() / ".hermes/profiles/analyst"))),
        os.environ.get("ANALYST_SERVICE_TOKEN", ""),
    )
