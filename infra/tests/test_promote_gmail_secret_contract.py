#!/usr/bin/env python3
"""Safety contracts for Gmail OAuth secret promotion."""

from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "infra" / "scripts" / "promote_gmail_secret.sh"


class PromoteGmailSecretContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT_PATH.read_text(encoding="utf-8")

    def test_requires_exact_readonly_payload_outside_repo_with_mode_0600(self):
        self.assertIn('mode != 0o600', self.script)
        self.assertIn('"client_id", "client_secret", "refresh_token", "user_id", "scope"', self.script)
        self.assertIn('https://www.googleapis.com/auth/gmail.readonly', self.script)
        self.assertIn('value.get("user_id") != "me"', self.script)
        self.assertIn('Credential file must be stored outside the repository.', self.script)

    def test_requires_exact_sso_account_region_and_identity(self):
        self.assertIn('EXPECTED_ACCOUNT_ID="915328198276"', self.script)
        self.assertIn('EXPECTED_REGION="us-west-1"', self.script)
        self.assertIn('ADMIN_PROFILE="${MARKET_DASHBOARD_AWS_ADMIN_PROFILE:-market-dashboard-admin}"', self.script)
        self.assertIn("sso_account_id", self.script)
        self.assertIn("AWSReservedSSO_", self.script)
        self.assertIn("-u AWS_ACCESS_KEY_ID", self.script)
        self.assertIn("-u AWS_SECRET_ACCESS_KEY", self.script)
        self.assertIn("-u AWS_SESSION_TOKEN", self.script)
        for variable in (
            "AWS_SECURITY_TOKEN",
            "AWS_ROLE_ARN",
            "AWS_ROLE_SESSION_NAME",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
            "AWS_SHARED_CREDENTIALS_FILE",
            "AWS_CONFIG_FILE",
        ):
            self.assertIn(f"-u {variable}", self.script)
        self.assertIn("AWS_EC2_METADATA_DISABLED=true", self.script)
        self.assertIn("run_aws --version", self.script)

    def test_creates_only_after_authoritative_absence_and_never_prints_secret(self):
        self.assertIn("secretsmanager describe-secret", self.script)
        self.assertIn("ResourceNotFoundException", self.script)
        self.assertIn("secretsmanager create-secret", self.script)
        self.assertIn("secretsmanager put-secret-value", self.script)
        self.assertIn('--secret-string "file://${credential_file}"', self.script)
        self.assertNotIn("cat \"$credential_file\"", self.script)
        self.assertNotIn("get-secret-value", self.script)


if __name__ == "__main__":
    unittest.main()
