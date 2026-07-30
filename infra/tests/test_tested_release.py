#!/usr/bin/env python3
"""Tests for exact-commit release preparation and authenticated receipts."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "infra" / "scripts"))

import prepare_tested_release as release  # noqa: E402


def run_git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def make_git_repo(root: Path) -> tuple[Path, str]:
    repo = root / "repo"
    repo.mkdir()
    run_git(repo, "init", "-q")
    run_git(repo, "config", "user.email", "test@example.com")
    run_git(repo, "config", "user.name", "Release Test")
    (repo / "artifact.txt").write_text("committed\n", encoding="utf-8")
    run_git(repo, "add", "artifact.txt")
    run_git(repo, "commit", "-q", "-m", "tested release")
    return repo, run_git(repo, "rev-parse", "HEAD")


def verification_records(commit: str):
    empty_hash = hashlib.sha256(b"").hexdigest()
    return [
        {
            "id": verification_id,
            "command": list(command),
            "releaseCommit": commit,
            "passed": True,
            "returnCode": 0,
            "startedAt": "2026-07-27T20:00:00+00:00",
            "finishedAt": "2026-07-27T20:00:01+00:00",
            "stdoutSha256": empty_hash,
            "stderrSha256": empty_hash,
        }
        for verification_id, command in release.VERIFICATION_COMMANDS
    ]


def write_valid_receipt(
    root: Path,
    repo: Path,
    commit: str,
) -> tuple[Path, Path, dict]:
    release_dir = root / "tested-release"
    release_dir.mkdir(mode=0o700)
    release_dir.chmod(0o700)
    template_path = release_dir / "packaged-template.yaml"
    template_path.write_text(
        "\n".join(
            [
                "Parameters:",
                "  BuildVersion:",
                "    Type: String",
                "Resources:",
                "  Worker:",
                "    Type: AWS::Serverless::Function",
                "    Properties:",
                "      CodeUri:",
                f"        Bucket: {release.EXPECTED_BUCKET}",
                "        Key: tested-releases/code.zip",
                "        Version: version-1",
                "      Handler: app.handler",
                "      Runtime: python3.12",
                "",
            ]
        ),
        encoding="utf-8",
    )
    template_path.chmod(0o600)
    package = release.validate_packaged_template(template_path)
    template_object = {
        "bucket": release.EXPECTED_BUCKET,
        "key": f"tested-releases/{commit}/packaged-template.yaml",
        "versionId": "template-version-1",
        "contentSha256": package["sha256"],
        "contentLength": template_path.stat().st_size,
    }
    artifact_evidence = [
        {
            **artifact,
            "contentSha256": hashlib.sha256(b"artifact").hexdigest(),
            "contentLength": len(b"artifact"),
        }
        for artifact in package["artifacts"]
    ]
    metadata = release.exact_commit_metadata(repo, commit)
    archive = release.git_archive_bytes(repo, commit)
    key_path = root / "receipt.key"
    key_path.write_bytes(b"k" * 32)
    key_path.chmod(0o600)
    payload = {
        "schemaVersion": release.RECEIPT_SCHEMA_VERSION,
        "kind": release.RECEIPT_KIND,
        "createdAt": "2026-07-27T20:00:02+00:00",
        "releaseCommit": commit,
        "releaseTree": metadata["tree"],
        "sourceArchiveSha256": release.sha256_bytes(archive),
        "sourceManifestSha256": "1" * 64,
        "verifications": verification_records(commit),
        "package": {
            "templatePath": str(template_path),
            "templateSha256": package["sha256"],
            "templateCanonicalSha256": package["canonicalSha256"],
            "templateObject": template_object,
            "artifacts": artifact_evidence,
            "artifactBucket": release.EXPECTED_BUCKET,
        },
    }
    receipt = release.authenticated_receipt(payload, key_path.read_bytes())
    receipt_path = release_dir / "tested-release-receipt.json"
    release.write_receipt(receipt_path, receipt)
    return receipt_path, key_path, receipt


class TestedReleaseTests(unittest.TestCase):
    def test_git_archive_uses_exact_commit_and_ignores_dirty_live_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, commit = make_git_repo(root)
            (repo / "artifact.txt").write_text(
                "dirty operator work\n",
                encoding="utf-8",
            )
            (repo / "untracked.txt").write_text("not released\n", encoding="utf-8")
            destination = root / "archive"

            archive = release.git_archive_bytes(repo, commit)
            release.extract_git_archive(archive, destination)

            self.assertEqual(
                (destination / "artifact.txt").read_text(encoding="utf-8"),
                "committed\n",
            )
            self.assertFalse((destination / "untracked.txt").exists())
            self.assertEqual(
                release.exact_commit_metadata(repo, commit)["commit"],
                commit,
            )

    def test_detached_test_worktree_is_exact_and_removable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, commit = make_git_repo(root)
            (repo / "artifact.txt").write_text("dirty\n", encoding="utf-8")
            worktree = root / "test-worktree"

            release.create_detached_worktree(repo, commit, worktree)

            self.assertEqual(
                (worktree / "artifact.txt").read_text(encoding="utf-8"),
                "committed\n",
            )
            self.assertEqual(run_git(worktree, "rev-parse", "HEAD"), commit)
            release.remove_detached_worktree(repo, worktree)
            self.assertFalse(worktree.exists())

    def test_exact_40_character_commit_is_required(self):
        for invalid in ("", "abc", "A" * 40, "a" * 39, "a" * 41):
            with self.subTest(invalid=invalid):
                with self.assertRaises(release.ReleaseReceiptError):
                    release.require_commit(invalid)

    def test_authenticated_private_receipt_verifies_exact_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, commit = make_git_repo(root)
            receipt, key, _ = write_valid_receipt(root, repo, commit)

            result = release.verify_release_receipt(
                receipt,
                expected_commit=commit,
                key_path=key,
                repo_root=repo,
            )

            self.assertTrue(result["passed"])
            self.assertEqual(result["releaseCommit"], commit)
            self.assertEqual(
                result["artifacts"][0]["versionId"],
                "version-1",
            )
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)

    def test_dirty_live_source_after_receipt_does_not_change_verified_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, commit = make_git_repo(root)
            receipt, key, _ = write_valid_receipt(root, repo, commit)
            (repo / "artifact.txt").write_text(
                "dirty change after base receipt\n",
                encoding="utf-8",
            )
            (repo / "new-live-file.txt").write_text(
                "must never enter activation\n",
                encoding="utf-8",
            )

            result = release.verify_release_receipt(
                receipt,
                expected_commit=commit,
                key_path=key,
                repo_root=repo,
            )

            self.assertTrue(result["passed"])
            self.assertEqual(result["releaseCommit"], commit)
            self.assertEqual(
                result["templatePath"],
                str((root / "tested-release" / "packaged-template.yaml").resolve()),
            )

    def test_receipt_tampering_is_detected_before_evidence_is_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, commit = make_git_repo(root)
            receipt_path, key, receipt = write_valid_receipt(root, repo, commit)
            receipt["verifications"][0]["passed"] = False
            receipt_path.write_text(
                json.dumps(receipt),
                encoding="utf-8",
            )
            receipt_path.chmod(0o600)

            with self.assertRaises(release.ReleaseReceiptError) as caught:
                release.verify_release_receipt(
                    receipt_path,
                    expected_commit=commit,
                    key_path=key,
                    repo_root=repo,
                )

            self.assertEqual(
                caught.exception.code,
                "RELEASE_RECEIPT_AUTHENTICATION_FAILED",
            )

    def test_even_resigned_receipt_must_contain_every_fixed_test_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, commit = make_git_repo(root)
            receipt_path, key, receipt = write_valid_receipt(root, repo, commit)
            payload = release.receipt_payload(receipt)
            payload["verifications"] = payload["verifications"][:-1]
            replacement = release.authenticated_receipt(
                payload,
                key.read_bytes(),
            )
            receipt_path.write_text(json.dumps(replacement), encoding="utf-8")
            receipt_path.chmod(0o600)

            with self.assertRaises(release.ReleaseReceiptError) as caught:
                release.verify_release_receipt(
                    receipt_path,
                    expected_commit=commit,
                    key_path=key,
                    repo_root=repo,
                )

            self.assertEqual(
                caught.exception.code,
                "RELEASE_RECEIPT_TEST_EVIDENCE_INVALID",
            )

    def test_packaged_template_tampering_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, commit = make_git_repo(root)
            receipt_path, key, receipt = write_valid_receipt(root, repo, commit)
            template = Path(receipt["package"]["templatePath"])
            template.write_text(
                template.read_text(encoding="utf-8") + "# changed\n",
                encoding="utf-8",
            )
            template.chmod(0o600)

            with self.assertRaises(release.ReleaseReceiptError) as caught:
                release.verify_release_receipt(
                    receipt_path,
                    expected_commit=commit,
                    key_path=key,
                    repo_root=repo,
                )

            self.assertEqual(
                caught.exception.code,
                "RELEASE_RECEIPT_PACKAGE_MISMATCH",
            )

    def test_packaged_artifacts_must_have_exact_s3_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            template = Path(directory) / "template.yaml"
            template.write_text(
                "\n".join(
                    [
                        "Parameters:",
                        "  BuildVersion:",
                        "    Type: String",
                        "Resources:",
                        "  Worker:",
                        "    Type: AWS::Serverless::Function",
                        "    Properties:",
                        "      CodeUri:",
                        f"        Bucket: {release.EXPECTED_BUCKET}",
                        "        Key: code.zip",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            template.chmod(0o600)
            with self.assertRaises(release.ReleaseReceiptError) as caught:
                release.validate_packaged_template(template)
            self.assertEqual(
                caught.exception.code,
                "RELEASE_ARTIFACT_VERSION_MISSING",
            )

    def test_unversioned_package_references_are_pinned_deterministically(self):
        template = {
            "Parameters": {"BuildVersion": {"Type": "String"}},
            "Resources": {
                "Worker": {
                    "Properties": {
                        "CodeUri": {
                            "Bucket": release.EXPECTED_BUCKET,
                            "Key": "code.zip",
                        }
                    }
                }
            },
        }
        calls = []

        pinned = release.pin_packaged_s3_versions(
            template,
            version_resolver=lambda bucket, key: (
                calls.append((bucket, key)) or "version-9"
            ),
        )

        self.assertEqual(
            pinned["Resources"]["Worker"]["Properties"]["CodeUri"]["Version"],
            "version-9",
        )
        self.assertEqual(calls, [(release.EXPECTED_BUCKET, "code.zip")])

    def test_source_manifest_can_recheck_only_committed_archive_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tracked.txt").write_text("exact\n", encoding="utf-8")
            initial = release.source_manifest(root)
            (root / "generated.pyc").write_bytes(b"cache")
            self.assertEqual(
                release.source_manifest(root, paths=initial),
                initial,
            )
            (root / "tracked.txt").write_text("changed\n", encoding="utf-8")
            self.assertNotEqual(
                release.source_manifest(root, paths=initial),
                initial,
            )


if __name__ == "__main__":
    unittest.main()
