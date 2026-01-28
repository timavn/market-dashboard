
import boto3
import os
import time
from datetime import datetime

def upload_file(path, bucket='market-dashboard-csv-data'):
    if not os.path.exists(path):
        print(f"❌ File not found: {path}")
        return False
        
    s3 = boto3.client('s3')
    filename = os.path.basename(path)
    
    # Use 'uploads/' prefix to trigger lambda
    key = f"uploads/{filename}"
    
    print(f"Uploading {filename} to s3://{bucket}/{key}...")
    try:
        with open(path, 'rb') as f:
            s3.put_object(Bucket=bucket, Key=key, Body=f)
        print("✅ Upload successful")
        return True
    except Exception as e:
        print(f"❌ Upload failed: {e}")
        return False

def main():
    # Paths found in previous step
    positions_csv = "/Users/timsmith/Desktop/dashboard/performance/currentpositions/Individual-Positions-2026-01-27-213120.csv"
    transactions_csv = "/Users/timsmith/Desktop/dashboard/performance/transactions/Individual_XXX197_Transactions_20260128-022915.csv"
    
    print("--- Step 1: Uploading Positions (Anchor) ---")
    if upload_file(positions_csv):
        print("Waiting 5 seconds for processing...")
        time.sleep(5)
        
        print("\n--- Step 2: Uploading Transactions (History) ---")
        upload_file(transactions_csv)
        print("Done.")

if __name__ == "__main__":
    main()
