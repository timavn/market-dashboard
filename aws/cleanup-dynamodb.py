#!/usr/bin/env python3
"""
Clean up DynamoDB tables - removes all old test data and failed parsing attempts
Run this to start fresh before testing the new Lambda
"""

import boto3
import json
from botocore.exceptions import ClientError

def cleanup_table(table_name, region='us-east-1'):
    """Delete all items from a DynamoDB table"""
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(table_name)
    
    print(f"\n🧹 Cleaning up {table_name}...")
    
    try:
        # Scan to get all items
        response = table.scan()
        items = response.get('Items', [])
        
        if not items:
            print(f"   ✅ {table_name} is already empty")
            return
        
        print(f"   📊 Found {len(items)} items to delete")
        
        # Delete items in batches
        with table.batch_writer() as batch:
            for item in items:
                # Get the primary key
                if table_name == 'PortfolioSnapshots':
                    key = {'snapshotId': item['snapshotId'], 'timestamp': item['timestamp']}
                elif table_name == 'Holdings':
                    key = {'holdingId': item['holdingId']}
                elif table_name == 'ProcessingLogs':
                    key = {'logId': item['logId']}
                else:
                    print(f"   ❌ Unknown table structure for {table_name}")
                    continue
                
                batch.delete_item(Key=key)
        
        print(f"   ✅ Deleted {len(items)} items from {table_name}")
        
    except ClientError as e:
        print(f"   ❌ Error cleaning {table_name}: {e}")
    except Exception as e:
        print(f"   ❌ Unexpected error cleaning {table_name}: {e}")

def main():
    """Clean up all three tables"""
    print("🚀 Starting DynamoDB cleanup...")
    print("This will delete ALL data from:")
    print("  - PortfolioSnapshots")
    print("  - Holdings") 
    print("  - ProcessingLogs")
    
    # Clean up each table
    tables = ['PortfolioSnapshots', 'Holdings', 'ProcessingLogs']
    
    for table_name in tables:
        cleanup_table(table_name)
    
    print("\n🎉 Cleanup complete!")
    print("Tables are now empty and ready for fresh data from your latest CSV upload.")

if __name__ == "__main__":
    main()
