#!/usr/bin/env python3
"""Create the bounded latest-first index used by active Hedgeye reads."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import boto3

try:
    from aws_profile_contract import (
        ADMIN_PROFILE,
        LOCAL_PROFILE,
        AwsProfileContractError,
        verified_session,
    )
except ModuleNotFoundError:  # pragma: no cover - direct execution fallback
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from aws_profile_contract import (  # type: ignore
        ADMIN_PROFILE,
        LOCAL_PROFILE,
        AwsProfileContractError,
        verified_session,
    )


INDEX_NAME = "snapshotType-date-meta-index"
LEGACY_INDEX_NAME = "snapshotType-date-index"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="us-west-1")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--drop-legacy",
        action="store_true",
        help=f"delete the superseded {LEGACY_INDEX_NAME} after the new index is ACTIVE",
    )
    parser.add_argument("--read-profile", default=LOCAL_PROFILE)
    parser.add_argument("--admin-profile", default=None)
    args = parser.parse_args()
    if args.drop_legacy and not args.apply:
        parser.error("--drop-legacy requires --apply")
    if args.apply:
        if args.admin_profile != ADMIN_PROFILE:
            parser.error(f"--apply requires --admin-profile {ADMIN_PROFILE}")
        profile, purpose = args.admin_profile, "admin"
    else:
        if args.read_profile != LOCAL_PROFILE:
            parser.error(f"--read-profile must be {LOCAL_PROFILE}")
        if args.admin_profile not in (None, ""):
            parser.error("--admin-profile is only valid with --apply")
        profile, purpose = args.read_profile, "api"
    try:
        session = verified_session(profile, purpose=purpose, region=args.region)
    except AwsProfileContractError as error:
        parser.error(f"{error.error_code}: {error.detail}")
    client = session.client("dynamodb", region_name=args.region)
    description = client.describe_table(TableName="HedgeyeDailySnapshot")["Table"]
    indexes = {item.get("IndexName") for item in description.get("GlobalSecondaryIndexes") or []}
    if INDEX_NAME in indexes:
        print(f"{INDEX_NAME}: present")
        if args.drop_legacy and LEGACY_INDEX_NAME in indexes:
            client.update_table(
                TableName="HedgeyeDailySnapshot",
                GlobalSecondaryIndexUpdates=[
                    {"Delete": {"IndexName": LEGACY_INDEX_NAME}}
                ],
            )
            print(f"{LEGACY_INDEX_NAME}: deletion requested")
        return 0
    if not args.apply:
        print(f"{INDEX_NAME}: missing (rerun with --apply)")
        return 2
    client.update_table(
        TableName="HedgeyeDailySnapshot",
        AttributeDefinitions=[
            {"AttributeName": "date", "AttributeType": "S"},
            {"AttributeName": "snapshotType", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexUpdates=[
            {
                "Create": {
                    "IndexName": INDEX_NAME,
                    "KeySchema": [
                        {"AttributeName": "snapshotType", "KeyType": "HASH"},
                        {"AttributeName": "date", "KeyType": "RANGE"},
                    ],
                    "Projection": {
                        "ProjectionType": "INCLUDE",
                        "NonKeyAttributes": [
                            "scrapedAt",
                            "publishedAt",
                            "riskRangeCount",
                            "metricsCount",
                            "stockCount",
                            "cryptoCount",
                            "rankingCount",
                            "itemCount",
                            "changeCount",
                        ],
                    },
                }
            }
        ],
    )
    # table_exists does not wait for an ACTIVE index, so poll the table status.
    deadline = time.time() + 900
    while time.time() < deadline:
        current = client.describe_table(TableName="HedgeyeDailySnapshot")["Table"]
        state = next(
            (item.get("IndexStatus") for item in current.get("GlobalSecondaryIndexes") or []
             if item.get("IndexName") == INDEX_NAME),
            None,
        )
        print(f"{INDEX_NAME}: {state or 'CREATING'}")
        if state == "ACTIVE":
            if args.drop_legacy:
                current_indexes = {
                    item.get("IndexName")
                    for item in current.get("GlobalSecondaryIndexes") or []
                }
                if LEGACY_INDEX_NAME in current_indexes:
                    client.update_table(
                        TableName="HedgeyeDailySnapshot",
                        GlobalSecondaryIndexUpdates=[
                            {"Delete": {"IndexName": LEGACY_INDEX_NAME}}
                        ],
                    )
                    print(f"{LEGACY_INDEX_NAME}: deletion requested")
            return 0
        time.sleep(10)
    raise TimeoutError(f"Timed out waiting for {INDEX_NAME} to become ACTIVE")


if __name__ == "__main__":
    raise SystemExit(main())
