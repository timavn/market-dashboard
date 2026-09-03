#!/usr/bin/env python3
"""Validate the exact resource boundaries allowed in local principal policies."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


ALLOWED_GLOBAL_RESOURCES = {
    "arn:aws:s3:::market-dashboard-csv-data/hedgeye-email/messages/*": {
        "s3:GetObject",
        "s3:GetObjectVersion",
    },
    "arn:aws:s3:::market-dashboard-csv-data/hedgeye-email/assets/market-structure/*": {
        "s3:GetObject",
    },
    (
        "arn:aws:s3:::market-dashboard-csv-data/hedgeye-email/messages/"
        "manual-inflation-nowcast/*"
    ): {"s3:PutObject"},
    "arn:aws:s3:::market-dashboard-csv-data": {"s3:ListBucket"},
    "arn:aws:s3:::market-dashboard-csv-data/analyst-staging/*": {
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:PutObject",
    },
    "arn:aws:s3:::market-dashboard-csv-data/hedgeye-uploads/manual/*": {
        "s3:GetObject",
        "s3:PutObject",
    },
}
REQUIRED_GLOBAL_RESOURCE_CONDITIONS = {
    "arn:aws:s3:::market-dashboard-csv-data": {
        "StringEquals": {"s3:prefix": "analyst-staging/"},
    },
}
ALLOWED_WILDCARD_ACTIONS = {"cloudwatch:GetMetricStatistics"}


class PolicyValidationError(ValueError):
    """Raised when a local policy escapes its exact boundary."""


def as_string_list(value: Any, *, field: str, path: Path) -> list[str]:
    values = [value] if isinstance(value, str) else value
    if (
        not isinstance(values, list)
        or not values
        or any(not isinstance(item, str) or not item for item in values)
    ):
        raise PolicyValidationError(f"{path}: {field} must be nonempty strings")
    return values


def validate_policy(path: Path, *, account: str, region: str) -> None:
    policy = json.loads(path.read_text(encoding="utf-8"))
    statements = policy.get("Statement")
    if policy.get("Version") != "2012-10-17" or not isinstance(statements, list):
        raise PolicyValidationError(f"{path}: invalid IAM policy document")
    if not statements:
        raise PolicyValidationError(f"{path}: IAM policy has no statements")

    for statement in statements:
        if not isinstance(statement, dict) or statement.get("Effect") != "Allow":
            raise PolicyValidationError(f"{path}: only explicit Allow statements are valid")
        if any(
            field in statement
            for field in ("NotAction", "NotResource", "Principal", "NotPrincipal")
        ):
            raise PolicyValidationError(f"{path}: unsupported IAM statement operator")
        actions = as_string_list(statement.get("Action"), field="Action", path=path)
        resources = as_string_list(
            statement.get("Resource"),
            field="Resource",
            path=path,
        )
        action_set = set(actions)
        for resource in resources:
            if resource == "*":
                if action_set != ALLOWED_WILDCARD_ACTIONS:
                    raise PolicyValidationError(
                        f"{path}: Resource * is allowed only for "
                        "cloudwatch:GetMetricStatistics"
                    )
                continue
            if resource in ALLOWED_GLOBAL_RESOURCES:
                allowed_actions = ALLOWED_GLOBAL_RESOURCES[resource]
                if action_set - allowed_actions:
                    raise PolicyValidationError(
                        f"{path}: global resource {resource} grants "
                        "an unsupported action"
                    )
                expected_condition = REQUIRED_GLOBAL_RESOURCE_CONDITIONS.get(resource)
                if statement.get("Condition") != expected_condition:
                    requirement = "the exact staging-prefix condition" if expected_condition else "no condition"
                    raise PolicyValidationError(
                        f"{path}: global resource {resource} requires {requirement}"
                    )
                continue
            parts = resource.split(":")
            if len(parts) < 6 or parts[3] != region or parts[4] != account:
                raise PolicyValidationError(
                    f"{path}: resource targets {resource}, expected "
                    f"account {account} in {region}"
                )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("policies", nargs="+", type=Path)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        for path in arguments.policies:
            validate_policy(
                path,
                account=arguments.account,
                region=arguments.region,
            )
    except (OSError, json.JSONDecodeError, PolicyValidationError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
