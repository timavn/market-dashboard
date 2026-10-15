"""Fail-closed AWS profile selection for operator scripts.

The dashboard runtime and operator tools intentionally use different AWS
identities. This module validates the named profile before a caller creates a
client that can read or mutate AWS resources.
"""

from __future__ import annotations

import os
from typing import Any, Mapping

import boto3


EXPECTED_ACCOUNT_ID = "915328198276"
LOCAL_PROFILE = "market-dashboard-local"
BRIDGE_PROFILE = "market-dashboard-bridge"
ADMIN_PROFILE = "market-dashboard-admin"
PROFILE_KEYS = ("AWS_PROFILE", "AWS_DEFAULT_PROFILE")
PROFILE_OVERRIDE_KEYS = (
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
)
STATIC_CREDENTIAL_KEYS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
)


class AwsProfileContractError(RuntimeError):
    def __init__(self, error_code: str, detail: str):
        super().__init__(detail)
        self.error_code = error_code
        self.detail = detail


def _ambient_values(environment: Mapping[str, str]) -> list[str]:
    return [
        str(environment.get(key) or "").strip()
        for key in PROFILE_KEYS
        if str(environment.get(key) or "").strip()
    ]


def validate_environment(
    profile: str,
    *,
    environment: Mapping[str, str] | None = None,
    reject_static: bool = True,
) -> None:
    environment = os.environ if environment is None else environment
    if any(value != profile for value in _ambient_values(environment)):
        raise AwsProfileContractError(
            "AWS_PROFILE_ENVIRONMENT_OVERRIDE",
            "The AWS profile was overridden by the shell environment; clear the override and retry.",
        )
    if any(str(environment.get(key) or "").strip() for key in PROFILE_OVERRIDE_KEYS[2:]):
        raise AwsProfileContractError(
            "AWS_PROFILE_ENVIRONMENT_OVERRIDE",
            "An AWS config or credentials file override was found; clear it and use the named repository profile.",
        )
    if reject_static and any(str(environment.get(key) or "").strip() for key in STATIC_CREDENTIAL_KEYS):
        raise AwsProfileContractError(
            "AWS_PROFILE_STATIC_SESSION_REJECTED",
            "Ambient static or session credentials were found; clear them and use the named repository profile.",
        )


def _approved_identity(identity: Mapping[str, Any], profile: str, purpose: str) -> bool:
    if str(identity.get("Account") or "") != EXPECTED_ACCOUNT_ID:
        return False
    arn = str(identity.get("Arn") or "")
    if purpose == "admin":
        return arn.startswith(f"arn:aws:sts::{EXPECTED_ACCOUNT_ID}:assumed-role/")
    return arn == f"arn:aws:iam::{EXPECTED_ACCOUNT_ID}:user/{profile}"


def verified_session(
    profile: str,
    *,
    purpose: str,
    region: str = "us-west-1",
    environment: Mapping[str, str] | None = None,
) -> Any:
    expected_profile = {
        "api": LOCAL_PROFILE,
        "bridge": BRIDGE_PROFILE,
        "admin": ADMIN_PROFILE,
    }.get(purpose)
    if expected_profile is None:
        raise AwsProfileContractError("AWS_PROFILE_PURPOSE_INVALID", "The AWS profile purpose is not approved.")
    if profile != expected_profile:
        raise AwsProfileContractError(
            "AWS_PROFILE_NAME_INVALID",
            f"The {purpose} operation must use its dedicated repository profile.",
        )
    validate_environment(profile, environment=environment)
    try:
        session = boto3.session.Session(profile_name=profile, region_name=region)
        identity = session.client("sts").get_caller_identity()
    except Exception as error:  # boto3 exposes different exception classes for CLI/SSO versions.
        diagnostic = str(error).lower()
        if purpose == "admin" and any(token in diagnostic for token in (
            "expired",
            "sso session",
            "unauthorizedssotoken",
            "tokenretrieval",
        )):
            raise AwsProfileContractError(
                "AWS_ADMIN_LOGIN_REQUIRED",
                "The approved administrator SSO session is expired or unavailable; refresh it before changing AWS resources.",
            ) from None
        if "accessdenied" in diagnostic or "not authorized" in diagnostic or "unauthorizedoperation" in diagnostic:
            raise AwsProfileContractError(
                "AWS_AUTHORIZATION_DENIED",
                "The named AWS principal is authenticated but is not authorized for this operation.",
            ) from None
        raise AwsProfileContractError(
            "AWS_PROFILE_UNUSABLE",
            "The named AWS profile could not be verified.",
        ) from None
    if not _approved_identity(identity, profile, purpose):
        raise AwsProfileContractError(
            "AWS_PROFILE_WRONG_PRINCIPAL",
            "The named AWS profile resolved to an unapproved principal.",
        )
    return session


def pin_environment(profile: str, *, region: str = "us-west-1") -> None:
    """Make libraries that only honor process env use the verified profile."""
    for key in (*PROFILE_OVERRIDE_KEYS, *STATIC_CREDENTIAL_KEYS):
        os.environ.pop(key, None)
    os.environ["AWS_PROFILE"] = profile
    os.environ["AWS_DEFAULT_PROFILE"] = profile
    os.environ["AWS_REGION"] = region
    os.environ["AWS_DEFAULT_REGION"] = region
    os.environ["AWS_EC2_METADATA_DISABLED"] = "true"
