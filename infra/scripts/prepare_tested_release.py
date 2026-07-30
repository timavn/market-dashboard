#!/usr/bin/env python3
"""Prepare and verify an immutable, tested SAM release.

Preparation exports an exact Git commit into a private directory, runs the
fixed release gates there, verifies that the exported source did not change,
builds and packages SAM from that export, and writes a mode-0600 HMAC receipt.
Deployment and staged activation consume the receipt and packaged template;
they never build from the operator's live checkout.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.parse import parse_qs, urlparse

import boto3
import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
EXPECTED_ACCOUNT = "915328198276"
EXPECTED_REGION = "us-west-1"
EXPECTED_BUCKET = (
    f"market-dashboard-sam-artifacts-{EXPECTED_ACCOUNT}-{EXPECTED_REGION}"
)
EXPECTED_ADMIN_PROFILE = "market-dashboard-admin"
RECEIPT_SCHEMA_VERSION = 1
RECEIPT_KIND = "market-dashboard-tested-sam-release"
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
AWS_CREDENTIAL_ENVIRONMENT_KEYS = frozenset(
    {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SECURITY_TOKEN",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_ROLE_ARN",
        "AWS_ROLE_SESSION_NAME",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_CONFIG_FILE",
    }
)
DEFAULT_KEY_PATH = (
    Path.home()
    / "Library"
    / "Application Support"
    / "market-dashboard"
    / "tested-release-receipt.key"
)
DEFAULT_RELEASES_DIR = (
    Path.home()
    / "Library"
    / "Application Support"
    / "market-dashboard"
    / "tested-releases"
)

VERIFICATION_COMMANDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("npm-clean-install", ("npm", "ci")),
    ("node-operations", ("npm", "run", "test:ops")),
    (
        "jest-readiness-ui",
        ("npm", "test", "--", "--watchAll=false", "--runInBand"),
    ),
    (
        "generated-contract",
        ("python3", "infra/scripts/render_hermes_contract.py", "--check"),
    ),
    (
        "python-infrastructure",
        (
            "python3",
            "-m",
            "unittest",
            "discover",
            "-s",
            "infra/tests",
            "-p",
            "test_*.py",
        ),
    ),
    (
        "sam-validation",
        (
            "sam",
            "validate",
            "--lint",
            "--template-file",
            "infra/template.yaml",
        ),
    ),
)


class ReleaseReceiptError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class CloudFormationLoader(yaml.SafeLoader):
    """Decode short-form CloudFormation YAML tags into canonical mappings."""


def _cloudformation_tag(
    loader: CloudFormationLoader,
    tag_suffix: str,
    node: yaml.Node,
) -> Any:
    key = {
        "Ref": "Ref",
        "Sub": "Fn::Sub",
        "GetAtt": "Fn::GetAtt",
        "Join": "Fn::Join",
        "If": "Fn::If",
        "Equals": "Fn::Equals",
        "FindInMap": "Fn::FindInMap",
        "Select": "Fn::Select",
        "Split": "Fn::Split",
        "ImportValue": "Fn::ImportValue",
        "GetAZs": "Fn::GetAZs",
        "And": "Fn::And",
        "Or": "Fn::Or",
        "Not": "Fn::Not",
        "Condition": "Condition",
    }.get(tag_suffix, f"Fn::{tag_suffix}")
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
        if tag_suffix == "GetAtt" and isinstance(value, str):
            value = value.split(".", 1)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {key: value}


CloudFormationLoader.add_multi_constructor("!", _cloudformation_tag)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")


def load_template(value: str | bytes | Mapping[str, Any]) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    text = value.decode("utf-8") if isinstance(value, bytes) else value
    loaded = yaml.load(text, Loader=CloudFormationLoader)
    if not isinstance(loaded, Mapping):
        raise ReleaseReceiptError(
            "RELEASE_TEMPLATE_INVALID",
            "The packaged SAM template is not a mapping.",
        )
    return loaded


def canonical_template_sha256(
    value: str | bytes | Mapping[str, Any],
) -> str:
    return sha256_bytes(canonical_json_bytes(load_template(value)))


def require_commit(value: str) -> str:
    commit = str(value or "").strip()
    if COMMIT_PATTERN.fullmatch(commit) is None:
        raise ReleaseReceiptError(
            "RELEASE_COMMIT_INVALID",
            "MARKET_DASHBOARD_RELEASE_COMMIT must be an exact lowercase 40-character Git commit.",
        )
    return commit


def private_regular_file(path: Path, *, label: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise ReleaseReceiptError(
            "RELEASE_FILE_UNSAFE",
            f"{label} must be a regular non-symlink file.",
        )
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ReleaseReceiptError(
            "RELEASE_FILE_MODE_INVALID",
            f"{label} must have mode 0600.",
        )


def private_directory(path: Path, *, label: str) -> None:
    if path.is_symlink() or not path.is_dir():
        raise ReleaseReceiptError(
            "RELEASE_DIRECTORY_UNSAFE",
            f"{label} must be a regular non-symlink directory.",
        )
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ReleaseReceiptError(
            "RELEASE_DIRECTORY_MODE_INVALID",
            f"{label} must not be accessible by group or other users.",
        )


def load_or_create_key(path: Path, *, create: bool) -> bytes:
    path = path.expanduser().resolve(strict=False)
    if not path.exists():
        if not create:
            raise ReleaseReceiptError(
                "RELEASE_RECEIPT_KEY_MISSING",
                f"Tested-release receipt key is missing: {path}",
            )
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            os.write(descriptor, secrets.token_bytes(32))
        finally:
            os.close(descriptor)
    private_regular_file(path, label="Tested-release receipt key")
    key = path.read_bytes()
    if len(key) < 32:
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_KEY_INVALID",
            "Tested-release receipt key must contain at least 256 bits.",
        )
    return key


def receipt_payload(receipt: Mapping[str, Any]) -> dict[str, Any]:
    return {
        str(key): value
        for key, value in receipt.items()
        if key != "authentication"
    }


def sign_receipt(payload: Mapping[str, Any], key: bytes) -> str:
    return hmac.new(
        key,
        canonical_json_bytes(payload),
        hashlib.sha256,
    ).hexdigest()


def authenticated_receipt(
    payload: Mapping[str, Any],
    key: bytes,
) -> dict[str, Any]:
    return {
        **dict(payload),
        "authentication": {
            "algorithm": "HMAC-SHA256",
            "value": sign_receipt(payload, key),
        },
    }


def git_output(
    repo_root: Path,
    arguments: Sequence[str],
    *,
    binary: bool = False,
) -> str | bytes:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *arguments],
        check=False,
        capture_output=True,
        text=not binary,
    )
    if result.returncode:
        detail = (
            result.stderr.decode("utf-8", errors="replace")
            if binary
            else result.stderr
        )
        raise ReleaseReceiptError(
            "RELEASE_GIT_FAILED",
            f"git {' '.join(arguments)} failed: {str(detail).strip()[:500]}",
        )
    return result.stdout


def exact_commit_metadata(repo_root: Path, commit: str) -> dict[str, str]:
    commit = require_commit(commit)
    resolved = str(
        git_output(repo_root, ["rev-parse", "--verify", f"{commit}^{{commit}}"])
    ).strip()
    if resolved != commit:
        raise ReleaseReceiptError(
            "RELEASE_COMMIT_MISMATCH",
            "Git did not resolve the exact requested release commit.",
        )
    tree = str(
        git_output(repo_root, ["rev-parse", "--verify", f"{commit}^{{tree}}"])
    ).strip()
    if COMMIT_PATTERN.fullmatch(tree) is None:
        raise ReleaseReceiptError(
            "RELEASE_TREE_INVALID",
            "Git did not return an exact release tree object.",
        )
    return {"commit": commit, "tree": tree}


def git_archive_bytes(repo_root: Path, commit: str) -> bytes:
    return bytes(
        git_output(
            repo_root,
            ["archive", "--format=tar", commit],
            binary=True,
        )
    )


def extract_git_archive(archive: bytes, destination: Path) -> None:
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        members = bundle.getmembers()
        for member in members:
            relative = Path(member.name)
            if (
                relative.is_absolute()
                or ".." in relative.parts
                or member.issym()
                or member.islnk()
                or member.isdev()
            ):
                raise ReleaseReceiptError(
                    "RELEASE_ARCHIVE_UNSAFE",
                    f"Git archive contains an unsafe member: {member.name}",
                )
            target = (destination / relative).resolve(strict=False)
            try:
                target.relative_to(destination.resolve())
            except ValueError as error:
                raise ReleaseReceiptError(
                    "RELEASE_ARCHIVE_UNSAFE",
                    "Git archive member escapes the release directory.",
                ) from error
        bundle.extractall(destination)


def create_detached_worktree(
    repo_root: Path,
    commit: str,
    destination: Path,
) -> None:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repo_root),
            "worktree",
            "add",
            "--detach",
            str(destination),
            commit,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise ReleaseReceiptError(
            "RELEASE_WORKTREE_FAILED",
            f"Unable to create exact release worktree: {(result.stderr or result.stdout)[-500:]}",
        )
    resolved = str(
        git_output(destination, ["rev-parse", "--verify", "HEAD"])
    ).strip()
    if resolved != commit:
        raise ReleaseReceiptError(
            "RELEASE_WORKTREE_COMMIT_MISMATCH",
            "Detached test worktree did not resolve to the exact release commit.",
        )


def remove_detached_worktree(repo_root: Path, destination: Path) -> None:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repo_root),
            "worktree",
            "remove",
            "--force",
            str(destination),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise ReleaseReceiptError(
            "RELEASE_WORKTREE_CLEANUP_FAILED",
            f"Unable to remove private test worktree: {(result.stderr or result.stdout)[-500:]}",
        )


def source_manifest(
    root: Path,
    *,
    paths: Iterable[str] | None = None,
) -> dict[str, str]:
    if paths is not None:
        result = {}
        for relative in sorted(paths):
            path = root / relative
            if path.is_symlink() or not path.is_file():
                result[relative] = "missing"
            else:
                result[relative] = sha256_file(path)
        return result
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(root).as_posix()
        if (
            relative == ".git"
            or relative == "node_modules"
            or relative.startswith("node_modules/")
        ):
            continue
        result[relative] = sha256_file(path)
    return result


def source_manifest_sha256(manifest: Mapping[str, str]) -> str:
    return sha256_bytes(canonical_json_bytes(manifest))


def run_verification_commands(
    source_root: Path,
    *,
    release_commit: str,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> list[dict[str, Any]]:
    environment = {
        **{
            key: value
            for key, value in os.environ.items()
            if key not in AWS_CREDENTIAL_ENVIRONMENT_KEYS
        },
        "CI": "true",
        "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_REGION": EXPECTED_REGION,
        "AWS_DEFAULT_REGION": EXPECTED_REGION,
        "MARKET_DASHBOARD_BUILD_VERSION": release_commit,
    }
    records = []
    for verification_id, command in VERIFICATION_COMMANDS:
        started_at = datetime.now(timezone.utc)
        result = runner(
            list(command),
            cwd=source_root,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
        finished_at = datetime.now(timezone.utc)
        record = {
            "id": verification_id,
            "command": list(command),
            "releaseCommit": release_commit,
            "passed": result.returncode == 0,
            "returnCode": int(result.returncode),
            "startedAt": started_at.isoformat(),
            "finishedAt": finished_at.isoformat(),
            "stdoutSha256": sha256_bytes((result.stdout or "").encode()),
            "stderrSha256": sha256_bytes((result.stderr or "").encode()),
        }
        records.append(record)
        if result.returncode:
            diagnostic = (result.stderr or result.stdout or "failed")[-1000:]
            raise ReleaseReceiptError(
                "RELEASE_VERIFICATION_FAILED",
                f"{verification_id} failed with {result.returncode}: {diagnostic}",
            )
    return records


def _s3_url_reference(value: str) -> dict[str, str] | None:
    parsed = urlparse(value)
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path.lstrip("/"):
        return None
    version = (parse_qs(parsed.query).get("versionId") or [""])[0]
    return {
        "bucket": parsed.netloc,
        "key": parsed.path.lstrip("/"),
        "versionId": version,
    }


def packaged_s3_references(template: Mapping[str, Any]) -> list[dict[str, str]]:
    references: dict[tuple[str, str, str], dict[str, str]] = {}

    def visit(value: Any) -> None:
        if isinstance(value, Mapping):
            bucket = value.get("Bucket") or value.get("S3Bucket")
            key = value.get("Key") or value.get("S3Key")
            version = (
                value.get("Version")
                or value.get("VersionId")
                or value.get("S3ObjectVersion")
            )
            if bucket and key:
                reference = {
                    "bucket": str(bucket),
                    "key": str(key),
                    "versionId": str(version or ""),
                }
                references[
                    (
                        reference["bucket"],
                        reference["key"],
                        reference["versionId"],
                    )
                ] = reference
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)
        elif isinstance(value, str):
            reference = _s3_url_reference(value)
            if reference:
                references[
                    (
                        reference["bucket"],
                        reference["key"],
                        reference["versionId"],
                    )
                ] = reference

    visit(template)
    return sorted(
        references.values(),
        key=lambda item: (item["bucket"], item["key"], item["versionId"]),
    )


def pin_packaged_s3_versions(
    value: Any,
    *,
    version_resolver: Callable[[str, str], str],
) -> Any:
    """Return a template copy with every S3 reference pinned to one version."""

    if isinstance(value, Mapping):
        result = {
            str(key): pin_packaged_s3_versions(
                nested,
                version_resolver=version_resolver,
            )
            for key, nested in value.items()
        }
        bucket_key = "Bucket" if result.get("Bucket") else (
            "S3Bucket" if result.get("S3Bucket") else None
        )
        object_key = "Key" if result.get("Key") else (
            "S3Key" if result.get("S3Key") else None
        )
        if bucket_key and object_key:
            bucket = str(result[bucket_key])
            key = str(result[object_key])
            version_key = (
                "Version"
                if bucket_key == "Bucket"
                else "S3ObjectVersion"
            )
            version = str(
                result.get("Version")
                or result.get("VersionId")
                or result.get("S3ObjectVersion")
                or version_resolver(bucket, key)
            )
            result[version_key] = version
        return result
    if isinstance(value, list):
        return [
            pin_packaged_s3_versions(
                nested,
                version_resolver=version_resolver,
            )
            for nested in value
        ]
    if isinstance(value, str):
        reference = _s3_url_reference(value)
        if reference:
            version = reference["versionId"] or version_resolver(
                reference["bucket"],
                reference["key"],
            )
            return (
                f"s3://{reference['bucket']}/{reference['key']}"
                f"?versionId={version}"
            )
    return value


def validate_packaged_template(
    path: Path,
    *,
    expected_bucket: str = EXPECTED_BUCKET,
) -> dict[str, Any]:
    private_regular_file(path, label="Packaged release template")
    raw = path.read_bytes()
    template = load_template(raw)
    parameters = template.get("Parameters")
    if not isinstance(parameters, Mapping) or "BuildVersion" not in parameters:
        raise ReleaseReceiptError(
            "RELEASE_TEMPLATE_BUILD_VERSION_MISSING",
            "Packaged template does not expose the BuildVersion parameter.",
        )
    artifacts = packaged_s3_references(template)
    if not artifacts:
        raise ReleaseReceiptError(
            "RELEASE_TEMPLATE_ARTIFACTS_MISSING",
            "Packaged template contains no versioned S3 artifacts.",
        )
    for artifact in artifacts:
        if artifact["bucket"] != expected_bucket:
            raise ReleaseReceiptError(
                "RELEASE_ARTIFACT_BUCKET_MISMATCH",
                "Packaged template references an unexpected S3 bucket.",
            )
        if not artifact["versionId"] or artifact["versionId"] == "null":
            raise ReleaseReceiptError(
                "RELEASE_ARTIFACT_VERSION_MISSING",
                "Every packaged S3 artifact must have an immutable version ID.",
            )
    return {
        "path": str(path),
        "sha256": sha256_bytes(raw),
        "canonicalSha256": canonical_template_sha256(raw),
        "artifacts": artifacts,
    }


def verification_records_valid(
    records: Sequence[Mapping[str, Any]],
    *,
    release_commit: str,
) -> bool:
    expected = {
        verification_id: list(command)
        for verification_id, command in VERIFICATION_COMMANDS
    }
    if len(records) != len(expected):
        return False
    observed_ids = {str(record.get("id") or "") for record in records}
    if observed_ids != set(expected):
        return False
    return all(
        record.get("passed") is True
        and int(record.get("returnCode", -1)) == 0
        and record.get("releaseCommit") == release_commit
        and record.get("command") == expected[str(record.get("id"))]
        and SHA256_PATTERN.fullmatch(str(record.get("stdoutSha256") or ""))
        and SHA256_PATTERN.fullmatch(str(record.get("stderrSha256") or ""))
        for record in records
    )


def write_receipt(path: Path, receipt: Mapping[str, Any]) -> None:
    path = path.resolve(strict=False)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        payload = json.dumps(
            receipt,
            indent=2,
            sort_keys=True,
        ).encode("utf-8") + b"\n"
        os.write(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    private_regular_file(path, label="Tested-release receipt")


def verify_release_receipt(
    receipt_path: str | os.PathLike[str],
    *,
    expected_commit: str,
    key_path: str | os.PathLike[str] = DEFAULT_KEY_PATH,
    repo_root: Path = REPO_ROOT,
) -> dict[str, Any]:
    expected_commit = require_commit(expected_commit)
    path = Path(receipt_path)
    if not path.is_absolute():
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_PATH_INVALID",
            "Tested-release receipt path must be absolute.",
        )
    path = path.resolve(strict=False)
    private_regular_file(path, label="Tested-release receipt")
    private_directory(path.parent, label="Tested-release directory")
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_INVALID",
            "Tested-release receipt is unreadable.",
        ) from error
    if not isinstance(receipt, Mapping):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_INVALID",
            "Tested-release receipt must be a JSON object.",
        )
    if (
        receipt.get("schemaVersion") != RECEIPT_SCHEMA_VERSION
        or receipt.get("kind") != RECEIPT_KIND
        or receipt.get("releaseCommit") != expected_commit
    ):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_CONTRACT_MISMATCH",
            "Tested-release receipt schema, kind, or commit does not match.",
        )
    authentication = receipt.get("authentication")
    key = load_or_create_key(Path(key_path), create=False)
    expected_mac = sign_receipt(receipt_payload(receipt), key)
    if (
        not isinstance(authentication, Mapping)
        or authentication.get("algorithm") != "HMAC-SHA256"
        or not hmac.compare_digest(
            str(authentication.get("value") or ""),
            expected_mac,
        )
    ):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_AUTHENTICATION_FAILED",
            "Tested-release receipt HMAC does not verify.",
        )
    metadata = exact_commit_metadata(repo_root, expected_commit)
    if receipt.get("releaseTree") != metadata["tree"]:
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_TREE_MISMATCH",
            "Tested-release receipt does not match the immutable Git tree.",
        )
    archive = git_archive_bytes(repo_root, expected_commit)
    if receipt.get("sourceArchiveSha256") != sha256_bytes(archive):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_ARCHIVE_MISMATCH",
            "Tested-release receipt does not match the exact Git archive.",
        )
    if not verification_records_valid(
        receipt.get("verifications") or [],
        release_commit=expected_commit,
    ):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_TEST_EVIDENCE_INVALID",
            "Tested-release receipt does not prove every fixed gate for the exact commit.",
        )
    package = receipt.get("package")
    if not isinstance(package, Mapping):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_PACKAGE_INVALID",
            "Tested-release receipt has no package evidence.",
        )
    template_path = Path(str(package.get("templatePath") or ""))
    if not template_path.is_absolute():
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_PACKAGE_INVALID",
            "Packaged template path must be absolute.",
        )
    template_path = template_path.resolve(strict=False)
    try:
        template_path.relative_to(path.parent)
    except ValueError as error:
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_PACKAGE_INVALID",
            "Packaged template must remain inside the private release directory.",
        ) from error
    validated_package = validate_packaged_template(template_path)
    template_object = package.get("templateObject")
    template_object_valid = (
        isinstance(template_object, Mapping)
        and template_object.get("bucket") == EXPECTED_BUCKET
        and bool(template_object.get("key"))
        and bool(template_object.get("versionId"))
        and template_object.get("versionId") != "null"
        and template_object.get("contentSha256")
        == validated_package["sha256"]
        and int(template_object.get("contentLength", -1))
        == template_path.stat().st_size
    )
    receipt_artifacts = package.get("artifacts")
    if not isinstance(receipt_artifacts, list):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_PACKAGE_INVALID",
            "Tested-release receipt has no S3 artifact checksums.",
        )
    receipt_references = [
        {
            "bucket": artifact.get("bucket"),
            "key": artifact.get("key"),
            "versionId": artifact.get("versionId"),
        }
        for artifact in receipt_artifacts
        if isinstance(artifact, Mapping)
    ]
    artifact_evidence_valid = (
        len(receipt_references) == len(receipt_artifacts)
        and all(
            SHA256_PATTERN.fullmatch(
                str(artifact.get("contentSha256") or "")
            )
            is not None
            and int(artifact.get("contentLength", -1)) >= 0
            for artifact in receipt_artifacts
        )
    )
    if (
        package.get("templateSha256") != validated_package["sha256"]
        or package.get("templateCanonicalSha256")
        != validated_package["canonicalSha256"]
        or receipt_references != validated_package["artifacts"]
        or not artifact_evidence_valid
        or not template_object_valid
    ):
        raise ReleaseReceiptError(
            "RELEASE_RECEIPT_PACKAGE_MISMATCH",
            "Packaged template or S3 artifact evidence changed after testing.",
        )
    return {
        "passed": True,
        "receiptPath": str(path),
        "releaseCommit": expected_commit,
        "releaseTree": metadata["tree"],
        "sourceArchiveSha256": receipt["sourceArchiveSha256"],
        "templatePath": str(template_path),
        "templateSha256": validated_package["sha256"],
        "templateCanonicalSha256": validated_package["canonicalSha256"],
        "templateObject": dict(template_object),
        "artifacts": receipt_artifacts,
        "receiptAuthentication": authentication["value"],
    }


def _run_checked(
    command: Sequence[str],
    *,
    cwd: Path,
    environment: Mapping[str, str],
) -> None:
    result = subprocess.run(
        list(command),
        cwd=cwd,
        env=dict(environment),
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        diagnostic = (result.stderr or result.stdout or "failed")[-1000:]
        raise ReleaseReceiptError(
            "RELEASE_PACKAGE_FAILED",
            f"{' '.join(command[:2])} failed with {result.returncode}: {diagnostic}",
        )


def prepare_release(
    *,
    repo_root: Path,
    release_commit: str,
    output_dir: Path,
    key_path: Path,
    admin_profile: str,
    artifact_bucket: str,
) -> dict[str, Any]:
    release_commit = require_commit(release_commit)
    if admin_profile != EXPECTED_ADMIN_PROFILE:
        raise ReleaseReceiptError(
            "RELEASE_ADMIN_PROFILE_INVALID",
            f"Release packaging requires {EXPECTED_ADMIN_PROFILE}.",
        )
    if artifact_bucket != EXPECTED_BUCKET:
        raise ReleaseReceiptError(
            "RELEASE_ARTIFACT_BUCKET_MISMATCH",
            f"Release packaging requires {EXPECTED_BUCKET}.",
        )
    metadata = exact_commit_metadata(repo_root, release_commit)
    output_dir = output_dir.expanduser().resolve(strict=False)
    try:
        output_dir.relative_to(repo_root.resolve())
    except ValueError:
        pass
    else:
        raise ReleaseReceiptError(
            "RELEASE_DIRECTORY_UNSAFE",
            "Tested release output must be outside the repository.",
        )
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output_dir, 0o700)
    source_root = output_dir / "source"
    archive = git_archive_bytes(repo_root, release_commit)
    create_detached_worktree(repo_root, release_commit, source_root)
    try:
        before_manifest = source_manifest(source_root)
        before_digest = source_manifest_sha256(before_manifest)
        verifications = run_verification_commands(
            source_root,
            release_commit=release_commit,
        )
        after_digest = source_manifest_sha256(
            source_manifest(source_root, paths=before_manifest)
        )
        if before_digest != after_digest:
            raise ReleaseReceiptError(
                "RELEASE_SOURCE_CHANGED_DURING_TESTS",
                "A release gate modified source exported from the exact commit.",
            )
    finally:
        remove_detached_worktree(repo_root, source_root)

    environment = {
        **{
            key: value
            for key, value in os.environ.items()
            if key not in AWS_CREDENTIAL_ENVIRONMENT_KEYS
        },
        "AWS_PROFILE": admin_profile,
        "AWS_DEFAULT_PROFILE": admin_profile,
        "AWS_REGION": EXPECTED_REGION,
        "AWS_DEFAULT_REGION": EXPECTED_REGION,
        "AWS_EC2_METADATA_DISABLED": "true",
        "MARKET_DASHBOARD_BUILD_VERSION": release_commit,
    }
    build_source_root = output_dir / "build-source"
    extract_git_archive(archive, build_source_root)
    if source_manifest_sha256(source_manifest(build_source_root)) != before_digest:
        raise ReleaseReceiptError(
            "RELEASE_BUILD_SOURCE_MISMATCH",
            "Fresh build source does not match the tested Git archive.",
        )
    build_dir = output_dir / "sam-build"
    packaged_template = output_dir / "packaged-template.yaml"
    _run_checked(
        (
            "sam",
            "build",
            "--no-cached",
            "--template-file",
            str(build_source_root / "infra" / "template.yaml"),
            "--build-dir",
            str(build_dir),
        ),
        cwd=build_source_root,
        environment=environment,
    )
    _run_checked(
        (
            "sam",
            "package",
            "--template-file",
            str(build_dir / "template.yaml"),
            "--s3-bucket",
            artifact_bucket,
            "--s3-prefix",
            f"tested-releases/{release_commit}",
            "--output-template-file",
            str(packaged_template),
            "--profile",
            admin_profile,
            "--region",
            EXPECTED_REGION,
        ),
        cwd=build_source_root,
        environment=environment,
    )

    session = boto3.Session(
        profile_name=admin_profile,
        region_name=EXPECTED_REGION,
    )
    identity = session.client("sts").get_caller_identity()
    arn = str(identity.get("Arn") or "")
    if (
        str(identity.get("Account") or "") != EXPECTED_ACCOUNT
        or not arn.startswith(
            f"arn:aws:sts::{EXPECTED_ACCOUNT}:assumed-role/AWSReservedSSO_"
        )
    ):
        raise ReleaseReceiptError(
            "RELEASE_AWS_IDENTITY_INVALID",
            "Release packaging requires the expected administrator SSO account.",
        )
    s3 = session.client("s3")

    def resolve_version(bucket: str, key: str) -> str:
        if bucket != artifact_bucket:
            raise ReleaseReceiptError(
                "RELEASE_ARTIFACT_BUCKET_MISMATCH",
                "SAM package emitted an object outside the fixed artifact bucket.",
            )
        head = s3.head_object(
            Bucket=bucket,
            Key=key,
            ExpectedBucketOwner=EXPECTED_ACCOUNT,
        )
        version = str(head.get("VersionId") or "")
        if not version or version == "null":
            raise ReleaseReceiptError(
                "RELEASE_ARTIFACT_VERSION_MISSING",
                "SAM artifact bucket did not return an immutable object version.",
            )
        return version

    parsed_template = load_template(packaged_template.read_bytes())
    pinned_template = pin_packaged_s3_versions(
        parsed_template,
        version_resolver=resolve_version,
    )
    packaged_template.write_text(
        yaml.safe_dump(
            pinned_template,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    os.chmod(packaged_template, 0o600)
    package = validate_packaged_template(packaged_template)
    template_bytes = packaged_template.read_bytes()
    template_key = (
        f"tested-releases/{release_commit}/packaged-template.yaml"
    )
    template_upload = s3.put_object(
        Bucket=artifact_bucket,
        Key=template_key,
        Body=template_bytes,
        ContentType="application/x-yaml",
        Metadata={"content-sha256": package["sha256"]},
        ServerSideEncryption="AES256",
        ExpectedBucketOwner=EXPECTED_ACCOUNT,
    )
    template_version = str(template_upload.get("VersionId") or "")
    if not template_version or template_version == "null":
        raise ReleaseReceiptError(
            "RELEASE_TEMPLATE_VERSION_MISSING",
            "Packaged template upload did not return an immutable S3 version.",
        )
    template_object = {
        "bucket": artifact_bucket,
        "key": template_key,
        "versionId": template_version,
        "contentSha256": package["sha256"],
        "contentLength": len(template_bytes),
    }
    template_download = s3.get_object(
        Bucket=artifact_bucket,
        Key=template_key,
        VersionId=template_version,
        ExpectedBucketOwner=EXPECTED_ACCOUNT,
    )
    downloaded_stream = template_download.get("Body")
    downloaded_template = (
        downloaded_stream.read()
        if hasattr(downloaded_stream, "read")
        else downloaded_stream
    )
    if (
        str(template_download.get("VersionId") or "") != template_version
        or not isinstance(downloaded_template, bytes)
        or sha256_bytes(downloaded_template) != package["sha256"]
    ):
        raise ReleaseReceiptError(
            "RELEASE_TEMPLATE_UPLOAD_MISMATCH",
            "Downloaded packaged-template version does not match the tested template.",
        )
    artifact_evidence = []
    for artifact in package["artifacts"]:
        response = s3.get_object(
            Bucket=artifact["bucket"],
            Key=artifact["key"],
            VersionId=artifact["versionId"],
            ExpectedBucketOwner=EXPECTED_ACCOUNT,
        )
        if str(response.get("VersionId") or "") != artifact["versionId"]:
            raise ReleaseReceiptError(
                "RELEASE_ARTIFACT_VERSION_MISMATCH",
                "S3 did not return the exact packaged artifact version.",
            )
        body_stream = response.get("Body")
        body = body_stream.read() if hasattr(body_stream, "read") else body_stream
        if not isinstance(body, bytes):
            raise ReleaseReceiptError(
                "RELEASE_ARTIFACT_CONTENT_INVALID",
                "S3 packaged artifact body was unreadable.",
            )
        artifact_evidence.append(
            {
                **artifact,
                "contentSha256": sha256_bytes(body),
                "contentLength": len(body),
            }
        )

    key = load_or_create_key(key_path, create=True)
    payload = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "kind": RECEIPT_KIND,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "releaseCommit": release_commit,
        "releaseTree": metadata["tree"],
        "sourceArchiveSha256": sha256_bytes(archive),
        "sourceManifestSha256": before_digest,
        "verifications": verifications,
        "package": {
            "templatePath": package["path"],
            "templateSha256": package["sha256"],
            "templateCanonicalSha256": package["canonicalSha256"],
            "templateObject": template_object,
            "artifacts": artifact_evidence,
            "artifactBucket": artifact_bucket,
        },
    }
    receipt_path = output_dir / "tested-release-receipt.json"
    write_receipt(receipt_path, authenticated_receipt(payload, key))
    return verify_release_receipt(
        receipt_path,
        expected_commit=release_commit,
        key_path=key_path,
        repo_root=repo_root,
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare or verify an immutable tested SAM release receipt.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument(
        "--commit",
        default=os.environ.get("MARKET_DASHBOARD_RELEASE_COMMIT"),
    )
    prepare.add_argument(
        "--output-dir",
        type=Path,
        default=None,
    )
    prepare.add_argument(
        "--receipt-key",
        type=Path,
        default=Path(
            os.environ.get(
                "MARKET_DASHBOARD_RELEASE_RECEIPT_KEY",
                DEFAULT_KEY_PATH,
            )
        ),
    )
    prepare.add_argument(
        "--admin-profile",
        default=EXPECTED_ADMIN_PROFILE,
    )
    prepare.add_argument(
        "--artifact-bucket",
        default=EXPECTED_BUCKET,
    )

    verify = subparsers.add_parser("verify")
    verify.add_argument("--receipt", required=True)
    verify.add_argument("--expected-commit", required=True)
    verify.add_argument(
        "--receipt-key",
        default=os.environ.get(
            "MARKET_DASHBOARD_RELEASE_RECEIPT_KEY",
            str(DEFAULT_KEY_PATH),
        ),
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        if args.command == "prepare":
            commit = require_commit(args.commit)
            output_dir = args.output_dir or (DEFAULT_RELEASES_DIR / commit)
            result = prepare_release(
                repo_root=REPO_ROOT,
                release_commit=commit,
                output_dir=output_dir,
                key_path=args.receipt_key,
                admin_profile=args.admin_profile,
                artifact_bucket=args.artifact_bucket,
            )
        else:
            result = verify_release_receipt(
                args.receipt,
                expected_commit=args.expected_commit,
                key_path=args.receipt_key,
                repo_root=REPO_ROOT,
            )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except ReleaseReceiptError as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "error": {"code": error.code, "message": str(error)},
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
