#!/usr/bin/env python3
"""
Daily CSV Upload Script
Automates the process of uploading Schwab CSV files to S3 for processing
"""

import boto3
import os
import glob
from datetime import datetime
import argparse

def upload_csv_to_s3(csv_file_path, bucket_name='market-dashboard-csv-data', prefix='uploads/'):
    """Upload CSV file to S3 bucket with timestamp"""
    s3_client = boto3.client('s3')
    
    # Generate timestamped filename
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = os.path.basename(csv_file_path)
    name, ext = os.path.splitext(filename)
    s3_key = f"{prefix}{name}_{timestamp}{ext}"
    
    try:
        s3_client.upload_file(csv_file_path, bucket_name, s3_key)
        print(f"✅ Uploaded {csv_file_path} to s3://{bucket_name}/{s3_key}")
        return s3_key
    except Exception as e:
        print(f"❌ Error uploading {csv_file_path}: {e}")
        return None

def find_latest_csv(directory):
    """Find the most recent CSV file in a directory"""
    csv_files = glob.glob(os.path.join(directory, "*.csv"))
    if not csv_files:
        return None
    
    # Return the most recently modified file
    latest_file = max(csv_files, key=os.path.getmtime)
    return latest_file

def main():
    parser = argparse.ArgumentParser(description='Upload Schwab CSV to S3 for processing')
    parser.add_argument('--file', '-f', help='Path to CSV file to upload')
    parser.add_argument('--directory', '-d', help='Directory to search for latest CSV file')
    parser.add_argument('--bucket', '-b', default='market-dashboard-csv-data', help='S3 bucket name')
    parser.add_argument('--prefix', '-p', default='uploads/', help='S3 key prefix')
    
    args = parser.parse_args()
    
    if args.file:
        # Upload specific file
        if not os.path.exists(args.file):
            print(f"❌ File not found: {args.file}")
            return
        
        s3_key = upload_csv_to_s3(args.file, args.bucket, args.prefix)
        if s3_key:
            print(f"🚀 Lambda should now process: s3://{args.bucket}/{s3_key}")
    
    elif args.directory:
        # Find and upload latest CSV in directory
        if not os.path.exists(args.directory):
            print(f"❌ Directory not found: {args.directory}")
            return
        
        latest_csv = find_latest_csv(args.directory)
        if not latest_csv:
            print(f"❌ No CSV files found in {args.directory}")
            return
        
        print(f"📁 Found latest CSV: {latest_csv}")
        s3_key = upload_csv_to_s3(latest_csv, args.bucket, args.prefix)
        if s3_key:
            print(f"🚀 Lambda should now process: s3://{args.bucket}/{s3_key}")
    
    else:
        # Interactive mode
        print("📋 Daily CSV Upload Tool")
        print("1. Upload specific file")
        print("2. Upload latest CSV from directory")
        
        choice = input("Choose option (1 or 2): ").strip()
        
        if choice == "1":
            file_path = input("Enter CSV file path: ").strip()
            if os.path.exists(file_path):
                s3_key = upload_csv_to_s3(file_path, args.bucket, args.prefix)
                if s3_key:
                    print(f"🚀 Lambda should now process: s3://{args.bucket}/{s3_key}")
            else:
                print(f"❌ File not found: {file_path}")
        
        elif choice == "2":
            directory = input("Enter directory path: ").strip()
            if os.path.exists(directory):
                latest_csv = find_latest_csv(directory)
                if latest_csv:
                    print(f"📁 Found latest CSV: {latest_csv}")
                    s3_key = upload_csv_to_s3(latest_csv, args.bucket, args.prefix)
                    if s3_key:
                        print(f"🚀 Lambda should now process: s3://{args.bucket}/{s3_key}")
                else:
                    print(f"❌ No CSV files found in {directory}")
            else:
                print(f"❌ Directory not found: {directory}")
        
        else:
            print("❌ Invalid choice")

if __name__ == "__main__":
    main()
