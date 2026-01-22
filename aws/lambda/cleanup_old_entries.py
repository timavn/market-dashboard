#!/usr/bin/env python3
"""
Delete old DynamoDB entries for snapshot types that need to be re-processed with correct dates
"""

import boto3
from datetime import datetime, timezone

db = boto3.resource('dynamodb', region_name='us-west-1')
table = db.Table('HedgeyeDailySnapshot')

# Define which entries to delete (date + snapshotType combinations)
entries_to_delete = [
    {'date': '2026-01-21', 'snapshotType': 'bitcoin-trend-tracker'},
    {'date': '2026-01-21', 'snapshotType': 'portfolio-solutions'},
]

print("\n" + "="*70)
print("🗑️  DELETING OLD DYNAMODB ENTRIES")
print("="*70 + "\n")

for entry in entries_to_delete:
    try:
        print(f"Deleting: {entry['snapshotType']} (date={entry['date']})")
        table.delete_item(Key=entry)
        print(f"  ✅ Deleted")
    except Exception as e:
        print(f"  ❌ Error: {e}")

print("\n" + "="*70)
print("✨ CLEANUP COMPLETE")
print("="*70 + "\n")
