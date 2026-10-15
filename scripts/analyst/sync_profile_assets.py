"""Install managed Analyst instructions without deleting user-installed skills."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile


def checked_root(path: Path) -> Path:
    path = Path(path).absolute()
    if path.is_symlink():
        raise ValueError(f"Asset root is a symlink: {path}")
    return path.resolve()


def reject_symlinks(path: Path, boundary: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError(f"Asset path is a symlink: {item}")
        if item == boundary:
            break


def checked_roots(*paths: Path) -> tuple[Path, ...]:
    raw = [Path(path).absolute() for path in paths]
    boundary = Path(os.path.commonpath(raw))
    for path in raw:
        reject_symlinks(path, boundary)
    return tuple(checked_root(path) for path in raw)


def sync_assets(source: Path, target: Path) -> list[str]:
    source, target = checked_roots(source, target)
    candidates = [source / "SOUL.md"]
    for section in ("skills", "plugins"):
        base = source / section
        if base.exists():
            candidates.extend([base, *sorted(base.rglob("*"))])
    installed = []
    plan = []
    for item in candidates:
        relative = item.relative_to(source)
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        reject_symlinks(item, source)
        if not item.is_file():
            continue
        destination = target / relative
        reject_symlinks(destination, target)
        if not destination.resolve().is_relative_to(target):
            raise ValueError(f"Asset destination escapes the profile: {relative}")
        plan.append((item, relative, destination))
    for item, relative, destination in plan:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
            temporary.write(item.read_bytes())
            temporary_path = Path(temporary.name)
        try:
            temporary_path.chmod(0o600)
            os.replace(temporary_path, destination)
        finally:
            temporary_path.unlink(missing_ok=True)
        installed.append(str(relative))
    return installed


def plan_retired_skills(source: Path, target: Path, retired_paths: list[str], archive_root: Path | None) -> list[Path]:
    """Validate explicit retirement before installing or moving any assets."""
    if not retired_paths:
        return []
    if archive_root is None:
        raise ValueError("--archive-root is required when retiring a skill")
    source, target, archive = checked_roots(source, target, archive_root)
    if archive.is_relative_to(target) or target.is_relative_to(archive) or archive.is_relative_to(source):
        raise ValueError("Retired skill archive must be outside the target profile and managed source")
    planned = []
    for name in dict.fromkeys(retired_paths):
        relative = PurePosixPath(name)
        if (
            relative.is_absolute() or len(relative.parts) < 2 or relative.parts[0] != "skills"
            or any(part in (".", "..", "") or part.startswith(".") for part in name.split("/"))
            or "\\" in name or "\x00" in name
        ):
            raise ValueError(f"Retired path must name an explicit skill directory: {name}")
        retired = target / relative
        reject_symlinks(retired, target)
        if (source / relative).exists() or (source / relative).is_symlink():
            raise ValueError(f"Retired skill is still in the managed source: {name}")
        if not retired.exists():
            continue
        skill_file = retired / "SKILL.md"
        reject_symlinks(skill_file, target)
        if not retired.is_dir() or not skill_file.is_file():
            raise ValueError(f"Retired path is not a skill directory: {name}")
        if any(retired.is_relative_to(other) or other.is_relative_to(retired) for other in planned):
            raise ValueError(f"Retired skill paths overlap: {name}")
        planned.append(retired)
    return planned


def archive_retired_skills(target: Path, planned: list[Path], archive_root: Path) -> Path | None:
    """Move only the validated skill directories into a recoverable batch."""
    if not planned:
        return None
    target, archive_root = checked_roots(target, archive_root)
    archive_root.mkdir(parents=True, exist_ok=True)
    archive_root.chmod(0o700)
    prefix = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-")
    batch = Path(tempfile.mkdtemp(prefix=prefix, dir=archive_root))
    for retired in planned:
        relative = retired.relative_to(target)
        reject_symlinks(retired, target)
        destination = batch / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(retired), str(destination))
    return batch


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--retire", action="append", default=[], help="Explicit relative skill directory to archive; may be repeated")
    parser.add_argument("--archive-root", type=Path, help="Target-specific recovery directory outside the profile")
    arguments = parser.parse_args()
    retired = plan_retired_skills(arguments.source, arguments.target, arguments.retire, arguments.archive_root)
    installed = sync_assets(arguments.source, arguments.target)
    archive = archive_retired_skills(arguments.target, retired, arguments.archive_root) if retired else None
    print(f"Installed {len(installed)} managed Analyst assets; archived {len(retired)} retired skills."
          + (f" Recovery: {archive}" if archive else ""))
