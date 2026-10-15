#!/usr/bin/env python3
"""Reproduce the frozen original Bitcoin study offline in an isolated repository.

Original source artifacts and scripts are only read. The preserved composer runs
with its original 10,000 bootstrap replicates, and every generated export must
match the frozen export byte for byte before results are copied to --output.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / "artifacts/btc-five-year-study/original-study"
OUTPUT = ROOT / "artifacts/btc-five-year-study/original-reproduction"
SESSION_PATH = "artifacts/btc-interval-experiment/source-sessions"
CHECKPOINT_PATH = "artifacts/btc-interval-experiment/source-quads/us-quarterly-checkpoint.json"
GENERATED_EXPORTS = ("study.json", "manifest.json", "README.md", "hourly-observations.csv",
                     "daily-observations.csv", "hourly-statistics.csv", "daily-statistics.csv",
                     "hourly-quad-statistics.csv", "daily-quad-statistics.csv", "statistics.csv")
PRESERVED_EXPORTS = ("settlement-checks.csv",)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def safe_path(directory, relative):
    relative = PurePosixPath(relative)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ValueError("Invalid archive-relative path")
    directory = Path(directory).resolve()
    path = directory.joinpath(*relative.parts).resolve()
    if not path.is_relative_to(directory):
        raise ValueError("Archive path escapes its directory")
    return path


def verify_archive(archive):
    archive = Path(archive).resolve()
    records = json.loads((archive / "archive-manifest.json").read_text())
    if not isinstance(records, list) or not records:
        raise ValueError("Original archive manifest is missing its file records")
    seen = set()
    for record in records:
        if record["path"] in seen:
            raise ValueError("Duplicate original archive manifest entry")
        seen.add(record["path"])
        if sha256(safe_path(archive, record["path"])) != record["sha256"]:
            raise ValueError(f"Original archive hash mismatch: {record['path']}")
    required = {"public/" + name for name in GENERATED_EXPORTS + PRESERVED_EXPORTS}
    required.add("scripts/btc_interval_study.py")
    if not required <= seen:
        raise ValueError("Original archive manifest omits a required export or composer")
    manifest = json.loads((archive / "public/manifest.json").read_text())
    if manifest.get("bootstrapReplicates") != 10000:
        raise ValueError("Original study must retain its frozen 10,000 bootstrap replicates")
    return records, manifest


def source_files(root, archive, manifest):
    """Resolve original input versions without using changed working scripts."""
    records, seen = [], set()
    for row in manifest["inputsAndScripts"]:
        relative = row["path"]
        if relative in seen:
            raise ValueError("Duplicate original study input")
        seen.add(relative)
        source = (safe_path(archive, "scripts/" + PurePosixPath(relative).name)
                  if relative.startswith("scripts/research/") else safe_path(root, relative))
        if sha256(source) != row["sha256"]:
            raise ValueError(f"Original study input hash mismatch: {relative}")
        records.append({**row, "source": source})
    return records


def session_responses(root):
    directory = safe_path(root, SESSION_PATH)
    manifest = json.loads((directory / "fetch-manifest.json").read_text())
    records = []
    seen = set()
    for request in manifest["requests"]:
        path = safe_path(directory, request["rawResponse"])
        metadata_path = path.with_suffix(".metadata.json")
        metadata = json.loads(metadata_path.read_text())
        raw = gzip.decompress(path.read_bytes())
        if (request.get("provider") != "coinbase" or request.get("httpStatus") != 200
                or hashlib.sha256(raw).hexdigest() != request["sha256"]
                or len(raw) != request.get("bodyBytes")
                or any(metadata.get(key) != request.get(key) for key in
                       ("url", "provider", "retrievedAt", "httpStatus", "sha256", "rawResponse", "bodyBytes"))):
            raise ValueError(f"Original session response hash or metadata mismatch: {request['rawResponse']}")
        for source in (path, metadata_path):
            relative = str(source.relative_to(Path(root).resolve()))
            if relative not in seen:
                records.append({"path": relative, "source": source, "sha256": sha256(source)})
                seen.add(relative)
    return records


def stage_repository(root, archive, destination):
    archived, manifest = verify_archive(archive)
    inputs = source_files(root, archive, manifest)
    raw_files = session_responses(root)
    copies = {row["path"]: row for row in inputs + raw_files}
    for record in archived:
        if record["path"].startswith("scripts/"):
            relative = "scripts/research/" + PurePosixPath(record["path"]).name
            copies[relative] = {"path": relative, "source": safe_path(archive, record["path"]),
                                "sha256": record["sha256"]}
    for relative, record in copies.items():
        target = safe_path(destination, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(record["source"], target)
        # The old composer writes this derived checkpoint; only its isolated copy is writable.
        target.chmod(0o644 if relative == CHECKPOINT_PATH else 0o444)
    return manifest, list(copies.values()), archived


def compare_exports(frozen, generated):
    records = []
    for filename in GENERATED_EXPORTS:
        before, after = sha256(Path(frozen) / filename), sha256(Path(generated) / filename)
        if before != after:
            raise ValueError(f"Original study reproduction differs: {filename}")
        records.append({"path": filename, "sha256": before, "byteIdentical": True, "recomputed": True})
    return records


def validate_output(output, root, archive, inputs):
    output, root, archive = Path(output).resolve(), Path(root).resolve(), Path(archive).resolve()
    protected = [archive, root / "public", root / "scripts", root / "src"]
    protected.extend(Path(row["source"]).resolve().parent for row in inputs)
    if output == root or any(output.is_relative_to(path) or path.is_relative_to(output) for path in protected):
        raise ValueError("Reproduction output overlaps preserved sources or application files")
    return output


def reproduce(root=ROOT, archive=ARCHIVE, output=OUTPUT):
    root, archive = Path(root).resolve(), Path(archive).resolve()
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="btc-original-reproduction-") as temporary:
        isolated = Path(temporary)
        manifest, sources, archived = stage_repository(root, archive, isolated)
        output = validate_output(output, root, archive, sources)
        generated = isolated / "artifacts/btc-interval-experiment"
        script = isolated / "scripts/research/btc_interval_study.py"
        # Guard Python network access and writes outside this disposable repository.
        runner = """import os,pathlib,runpy,sys
base=pathlib.Path(sys.argv[1]).resolve()
script=base/'scripts/research/btc_interval_study.py'
def audit(event,args):
    if event.startswith('socket.'):
        raise RuntimeError('Original study reproduction is offline')
    if event=='open' and isinstance(args[0],(str,bytes,os.PathLike)):
        flags=args[2]
        if flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_APPEND|os.O_TRUNC):
            if not pathlib.Path(os.fsdecode(args[0])).resolve().is_relative_to(base):
                raise RuntimeError('Write outside isolated reproduction repository')
sys.addaudithook(audit)
sys.path.insert(0,str(script.parent))
sys.argv=[str(script),'--bootstrap','10000']
runpy.run_path(str(script),run_name='__main__')
"""
        result = subprocess.run([sys.executable, "-c", runner, str(isolated)], cwd=isolated,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("Original composer failed in isolated reproduction:\n" + result.stderr[-8000:])
        compared = compare_exports(archive / "public", generated)
        # Verify both original files and copied inputs again after the composer ran.
        for row in sources:
            if sha256(row["source"]) != row["sha256"] or sha256(safe_path(isolated, row["path"])) != row["sha256"]:
                raise ValueError(f"Source changed during original study reproduction: {row['path']}")
        verify_archive(archive)
        output.mkdir(parents=True, exist_ok=True)
        for filename in GENERATED_EXPORTS:
            shutil.copyfile(generated / filename, safe_path(output, filename))
        for filename in PRESERVED_EXPORTS:
            shutil.copyfile(archive / "public" / filename, safe_path(output, filename))
            compared.append({"path": filename, "sha256": sha256(output / filename),
                             "byteIdentical": True, "recomputed": False,
                             "reason": "Legacy settlement export retained by the original interval study; not regenerated by its composer."})
        report = {"schemaVersion": 1, "status": "verified", "historicalResearchOnly": True,
                  "reproducedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                  "offline": True, "isolatedRepository": True, "originalSourcesUnchanged": True,
                  "bootstrapReplicates": 10000, "seed": manifest["seed"],
                  "archiveManifestSha256": sha256(archive / "archive-manifest.json"),
                  "verifiedArchivedFiles": len(archived), "verifiedSourceFiles": len(sources),
                  "elapsedSeconds": round(time.perf_counter() - started, 3),
                  "coverage": manifest["coverage"], "comparison": compared}
        safe_path(output, "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=ARCHIVE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    report = reproduce(archive=args.archive, output=args.output)
    print(json.dumps({"status": report["status"], "bootstrapReplicates": report["bootstrapReplicates"],
                      "recomputedByteIdenticalFiles": sum(row["recomputed"] for row in report["comparison"]),
                      "preservedLegacyFiles": sum(not row["recomputed"] for row in report["comparison"]),
                      "verifiedSourceFiles": report["verifiedSourceFiles"], "elapsedSeconds": report["elapsedSeconds"],
                      "comparisonReport": str(args.output / "comparison.json")}, indent=2))


if __name__ == "__main__":
    main()
