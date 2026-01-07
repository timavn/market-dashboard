#!/usr/bin/env python3
"""
Delete all uploaded statements except the most recent one from yesterday
This script will:
1. Find all PortfolioSnapshots
2. Identify the most recent one (should be from yesterday)
3. Delete all other snapshots
4. Delete associated Holdings records
5. Delete associated PerformanceHistory records
"""

import boto3
from datetime import datetime, timedelta, timezone
from botocore.exceptions import ClientError
import sys

# AWS Configuration
REGION = 'us-west-1'  # Change if your region is different
PORTFOLIO_TABLE = 'PortfolioSnapshots'
HOLDINGS_TABLE = 'Holdings'
PERFORMANCE_TABLE = 'PerformanceHistory'

def get_all_snapshots():
    """Get all portfolio snapshots"""
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(PORTFOLIO_TABLE)
    
    print("📊 Scanning PortfolioSnapshots table...")
    
    items = []
    response = table.scan()
    items.extend(response.get('Items', []))
    
    # Handle pagination if needed
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        items.extend(response.get('Items', []))
    
    print(f"   Found {len(items)} total snapshots")
    return items

def find_most_recent_snapshot(snapshots):
    """Find the most recent snapshot (should be from yesterday)"""
    if not snapshots:
        return None
    
    # Sort by timestamp descending (newest first)
    sorted_snapshots = sorted(
        snapshots,
        key=lambda x: x.get('timestamp', ''),
        reverse=True
    )
    
    most_recent = sorted_snapshots[0]
    timestamp = most_recent.get('timestamp', '')
    
    # Parse timestamp
    try:
        if not timestamp.endswith('Z'):
            timestamp += 'Z'
        date_obj = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        print(f"\n✅ Most recent snapshot found:")
        print(f"   Snapshot ID: {most_recent.get('snapshotId')}")
        print(f"   Timestamp: {timestamp}")
        print(f"   Date: {date_obj.strftime('%Y-%m-%d %H:%M:%S UTC')}")
        return most_recent
    except Exception as e:
        print(f"   ⚠️  Warning: Could not parse timestamp: {e}")
        # Still return the first one
        return most_recent

def delete_snapshot(snapshot_id, timestamp):
    """Delete a portfolio snapshot"""
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(PORTFOLIO_TABLE)
    
    try:
        # Try with composite key first (snapshotId + timestamp)
        # If that fails, try with just snapshotId
        key = {
            'snapshotId': snapshot_id
        }
        
        # Add timestamp if it exists (for composite key tables)
        if timestamp:
            key['timestamp'] = timestamp
        
        table.delete_item(Key=key)
        return True
    except ClientError as e:
        # If composite key fails, try just snapshotId
        if 'timestamp' in key:
            try:
                key = {'snapshotId': snapshot_id}
                table.delete_item(Key=key)
                return True
            except:
                pass
        print(f"   ❌ Error deleting snapshot {snapshot_id}: {e}")
        return False

def delete_holdings_for_snapshot(snapshot_id):
    """Delete all holdings associated with a snapshot"""
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(HOLDINGS_TABLE)
    
    print(f"   🗑️  Deleting holdings for snapshot {snapshot_id}...")
    
    try:
        # Scan for holdings with this snapshotId
        response = table.scan(
            FilterExpression='snapshotId = :snapshotId',
            ExpressionAttributeValues={':snapshotId': snapshot_id}
        )
        
        holdings = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression='snapshotId = :snapshotId',
                ExpressionAttributeValues={':snapshotId': snapshot_id},
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            holdings.extend(response.get('Items', []))
        
        if holdings:
            # Delete in batches
            with table.batch_writer() as batch:
                for holding in holdings:
                    batch.delete_item(Key={'holdingId': holding['holdingId']})
            print(f"      ✅ Deleted {len(holdings)} holdings")
        else:
            print(f"      ℹ️  No holdings found for this snapshot")
        
        return len(holdings)
    except ClientError as e:
        print(f"      ❌ Error deleting holdings: {e}")
        return 0

def delete_performance_history_for_snapshot(snapshot_id):
    """Delete performance history records associated with a snapshot"""
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(PERFORMANCE_TABLE)
    
    print(f"   🗑️  Checking performance history for snapshot {snapshot_id}...")
    
    try:
        # Scan for performance records with this snapshotId
        response = table.scan(
            FilterExpression='snapshotId = :snapshotId',
            ExpressionAttributeValues={':snapshotId': snapshot_id}
        )
        
        perf_records = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression='snapshotId = :snapshotId',
                ExpressionAttributeValues={':snapshotId': snapshot_id},
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            perf_records.extend(response.get('Items', []))
        
        if perf_records:
            # Delete records (PerformanceHistory uses 'date' as key)
            deleted_count = 0
            for record in perf_records:
                try:
                    table.delete_item(Key={'date': record['date']})
                    deleted_count += 1
                except Exception as e:
                    print(f"      ⚠️  Could not delete performance record for {record.get('date')}: {e}")
            
            print(f"      ✅ Deleted {deleted_count} performance history records")
            return deleted_count
        else:
            print(f"      ℹ️  No performance history found for this snapshot")
            return 0
    except ClientError as e:
        print(f"      ❌ Error deleting performance history: {e}")
        return 0

def main():
    """Main cleanup function"""
    print("🚀 Starting statement cleanup...")
    print("This will delete all statements EXCEPT the most recent one from yesterday")
    print()
    
    # Get all snapshots
    all_snapshots = get_all_snapshots()
    
    if not all_snapshots:
        print("✅ No snapshots found. Nothing to clean up.")
        return
    
    # Find most recent snapshot
    most_recent = find_most_recent_snapshot(all_snapshots)
    
    if not most_recent:
        print("❌ Could not find most recent snapshot")
        return
    
    keep_snapshot_id = most_recent.get('snapshotId')
    keep_timestamp = most_recent.get('timestamp')
    
    print(f"\n⚠️  KEEPING snapshot: {keep_snapshot_id}")
    print(f"   All other snapshots will be DELETED")
    print()
    
    # Check for --yes flag to skip confirmation
    import sys
    skip_confirmation = '--yes' in sys.argv or '-y' in sys.argv
    
    if not skip_confirmation:
        # Confirm deletion
        try:
            response = input("Continue with deletion? (yes/no): ").strip().lower()
            if response not in ['yes', 'y']:
                print("❌ Cancelled. No data was deleted.")
                return
        except EOFError:
            # If running non-interactively, proceed automatically
            print("⚠️  Running non-interactively. Proceeding with deletion...")
    else:
        print("⚠️  --yes flag provided. Proceeding with deletion...")
    
    print("\n🗑️  Starting deletion...")
    
    deleted_snapshots = 0
    deleted_holdings = 0
    deleted_performance = 0
    
    # Delete all snapshots except the most recent
    for snapshot in all_snapshots:
        snapshot_id = snapshot.get('snapshotId')
        timestamp = snapshot.get('timestamp')
        
        if snapshot_id == keep_snapshot_id:
            print(f"   ⏭️  Skipping (keeping): {snapshot_id}")
            continue
        
        print(f"\n🗑️  Deleting snapshot: {snapshot_id}")
        
        # Delete associated holdings
        holdings_count = delete_holdings_for_snapshot(snapshot_id)
        deleted_holdings += holdings_count
        
        # Delete associated performance history
        perf_count = delete_performance_history_for_snapshot(snapshot_id)
        deleted_performance += perf_count
        
        # Delete the snapshot itself
        if delete_snapshot(snapshot_id, timestamp):
            deleted_snapshots += 1
            print(f"   ✅ Deleted snapshot: {snapshot_id}")
        else:
            print(f"   ❌ Failed to delete snapshot: {snapshot_id}")
    
    print("\n" + "="*60)
    print("🎉 Cleanup complete!")
    print(f"   ✅ Kept snapshot: {keep_snapshot_id}")
    print(f"   🗑️  Deleted {deleted_snapshots} snapshots")
    print(f"   🗑️  Deleted {deleted_holdings} holdings records")
    print(f"   🗑️  Deleted {deleted_performance} performance history records")
    print("="*60)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n❌ Interrupted by user. No data was deleted.")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

