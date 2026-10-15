#!/usr/bin/env python3
"""Hermes pre-check for the dashboard's current, verified MOMO roster."""

import json
import fcntl
import hashlib
import os
import re
import subprocess
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


PROJECT = Path("/Users/timsmith/Desktop/cursor/market-dashboard")
NODE = Path("/Users/timsmith/.local/bin/node")
JOB_ID = "ca1eba88a28c"
MAX_HISTORY_FILES = 50
MAX_HISTORY_BYTES = 256_000
MAX_ADDITIONAL_TICKERS = 200
SCRIPT_INTRO = "The following data was collected by a pre-run script. Use it as context for your analysis."
SELF_INTRO = ("The following is this job's most recent output from its previous run. Use it for "
              "continuity: avoid repeating what was already reported, and continue where the last run "
              "left off.")


def verified_roster(result):
    """Only the bounded shape emitted after the existing verifier passes."""
    if not isinstance(result, dict) or result.get("status") != "ready":
        return False
    try:
        if date.fromisoformat(result.get("date", "")).isoformat() != result["date"]:
            return False
    except (TypeError, ValueError):
        return False
    top = result.get("top10Tickers")
    extra = result.get("momoAdditionalTickers")
    if not isinstance(top, list) or len(top) != 10 or not isinstance(extra, list) or len(extra) > MAX_ADDITIONAL_TICKERS:
        return False
    all_tickers = top + extra
    return len(set(str(ticker) for ticker in all_tickers)) == len(all_tickers) and all(
        isinstance(ticker, str) and re.fullmatch(r"[A-Z][A-Z0-9.]{0,9}", ticker) and ticker != "GOOG"
        for ticker in all_tickers
    ) and not any(result.get(flag) is True for flag in ("mock", "seed", "seeded", "stale", "cacheOnly", "fromCache", "inferred", "fallback"))


def extract_legacy_baseline(output_dir):
    """Read exact pre-check JSON, never a model's response or nested old prompt."""
    if output_dir.is_symlink():
        raise ValueError("History directory must belong to this profile")
    files = sorted((path for path in output_dir.glob("*.md") if not path.is_symlink() and path.is_file()),
                   key=lambda path: path.stat().st_mtime, reverse=True)[:MAX_HISTORY_FILES]
    marker = "\n## Script Output\n" + SCRIPT_INTRO + "\n\n```\n"
    for path in files:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_HISTORY_BYTES:
            continue
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            continue
        if not text.startswith("# Cron Job:"):
            continue
        _, prompt_marker, prompt = text.partition("\n## Prompt\n")
        if not prompt_marker:
            continue
        self_marker = "\n## Your previous run's output\n" + SELF_INTRO + "\n\n```\n"
        self_at = prompt.find(self_marker)
        script_at = prompt.find(marker)
        response_at = prompt.find("\n## Response\n")
        if self_at >= 0 and self_at < min((at for at in (script_at, response_at) if at >= 0), default=len(prompt)):
            # Hermes's recursive Markdown is not safely frameable when an old
            # response contains copied headings. Accept only its exact bounded
            # 8000-character context frame; otherwise try another saved run.
            end = self_at + len(self_marker) + 8000
            trailer = "\n\n[... output truncated ...]\n```\n\n"
            if not prompt.startswith(trailer, end):
                continue
            prompt = "\n" + prompt[end + len(trailer):]
        prompt, response_marker, _ = prompt.partition("\n## Response\n")
        if not response_marker:
            continue
        _, script_marker, block = prompt.partition(marker)
        if not script_marker:
            continue
        encoded, fence, _ = block.partition("\n```")
        if not fence:
            continue
        try:
            captured = json.loads(encoded)
        except ValueError:
            continue
        result = captured.get("rosterCheck") if isinstance(captured, dict) else None
        if not isinstance(captured, dict) or captured.get("wakeAgent") is not True or not verified_roster(result):
            continue
        return {"rosterCheck": result, "evidence": {
            "kind": "saved-precheck-output", "outputFile": str(path),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "verifier": "scripts/check_momo_roster.cjs", "endpoint": "/api/market/sp500-contributors",
        }}
    return None


def _save_baseline(path, snapshot):
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".momo-baseline-")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(snapshot, handle)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _group_change(previous, current):
    membership = set(previous) != set(current)
    return {"membershipChanged": membership, "orderingChanged": not membership and previous != current}


def build_payload(result, now, profile_home):
    """Compare exact verified groups before waking an agent; keep failures dated."""
    cron_dir = profile_home / "cron"
    if cron_dir.is_symlink() or profile_home.is_symlink():
        raise ValueError("Baseline storage must belong to this profile")
    if (cron_dir / "output").is_symlink():
        raise ValueError("History storage must belong to this profile")
    cron_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    baseline_path = cron_dir / "momo-roster-baseline.json"
    if baseline_path.is_symlink():
        raise ValueError("Baseline file must belong to this profile")
    lock_fd = os.open(cron_dir / ".momo-roster-baseline.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prior = None
        if baseline_path.exists():
            if baseline_path.stat().st_size > 16_000:
                raise ValueError("Baseline exceeds its bounded record size")
            prior = json.loads(baseline_path.read_text())
            evidence = prior.get("evidence") if isinstance(prior, dict) else None
            if (not isinstance(prior, dict) or not verified_roster(prior.get("rosterCheck"))
                    or not isinstance(evidence, dict)
                    or evidence.get("kind") not in {"saved-precheck-output", "deterministic-precheck"}
                    or evidence.get("verifier") != "scripts/check_momo_roster.cjs"
                    or evidence.get("endpoint") != "/api/market/sp500-contributors"):
                raise ValueError("Baseline is not a verified pre-check record")
        else:
            prior = extract_legacy_baseline(cron_dir / "output" / JOB_ID)
            if prior:
                _save_baseline(baseline_path, prior)
        payload = {"wakeAgent": wake_for(result, now), "rosterCheck": result,
                   "rosterComparison": {"status": "unavailable"}}
        if prior:
            payload["priorRoster"] = prior
        if not verified_roster(result):
            if result.get("status") == "ready":
                payload["rosterCheck"] = {"status": "unavailable", "reason": "roster_shape_unverified", "date": result.get("date")}
                payload["wakeAgent"] = True
            return payload
        previous = prior["rosterCheck"] if prior else None
        comparison = {"status": "baseline"}
        if previous:
            comparison.update(top10=_group_change(previous["top10Tickers"], result["top10Tickers"]),
                              momoAdditional=_group_change(previous["momoAdditionalTickers"], result["momoAdditionalTickers"]))
            changed = any(group["membershipChanged"] or group["orderingChanged"]
                          for group in (comparison["top10"], comparison["momoAdditional"]))
            comparison["status"] = "changed" if changed else "unchanged"
            payload["wakeAgent"] = changed
        payload["rosterComparison"] = comparison
        _save_baseline(baseline_path, {"rosterCheck": result, "evidence": {
            "kind": "deterministic-precheck", "verifiedAt": now.astimezone(timezone.utc).isoformat(),
            "verifier": "scripts/check_momo_roster.cjs", "endpoint": "/api/market/sp500-contributors",
        }})
        return payload


def wake_for(result, now):
    if result.get("status") == "skipped":
        return False
    if result.get("status") == "pending" and (now.hour, now.minute) < (8, 30):
        return False
    return True


def main():
    now = datetime.now(ZoneInfo("America/Los_Angeles"))
    try:
        completed = subprocess.run(
            [str(NODE), "scripts/check_momo_roster.cjs"],
            cwd=PROJECT, capture_output=True, text=True, timeout=45, check=False,
        )
        result = json.loads(completed.stdout)
        if not isinstance(result, dict) or result.get("status") not in {
            "ready", "pending", "skipped", "unavailable"
        } or (completed.returncode != 0 and result.get("status") != "unavailable"):
            raise ValueError("Invalid roster check result")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        result = {"status": "unavailable", "reason": "roster_check_failed"}

    # Scheduler-owned state keeps bounded continuity outside the agent's tools.
    try:
        if os.environ.get("HERMES_HOME"):
            profile_home = Path(os.environ["HERMES_HOME"])
        else:
            scripts_dir = Path(__file__).resolve().parent
            if scripts_dir.name != "scripts" or not (scripts_dir.parent / "config.yaml").is_file():
                raise ValueError("An explicit Hermes profile is required")
            profile_home = scripts_dir.parent
        payload = build_payload(result, now, profile_home)
    except (OSError, ValueError, TypeError):
        payload = {"wakeAgent": True, "rosterCheck": result,
                   "rosterComparison": {"status": "unavailable", "reason": "continuity_store_unavailable"}}
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
