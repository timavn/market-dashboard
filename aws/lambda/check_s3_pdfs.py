import boto3
import json
from datetime import datetime, timezone

def list_s3_pdfs():
    s3 = boto3.client('s3', region_name='us-west-1')
    bucket = 'market-dashboard-csv-data'
    prefix = 'hedgeye/'
    
    print(f"Listing files in s3://{bucket}/{prefix}...")
    try:
        response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
        if 'Contents' in response:
            files = sorted(response['Contents'], key=lambda x: x['LastModified'], reverse=True)
            for f in files[:20]:  # Show top 20
                print(f"{f['Key']} ({f['Size']} bytes) - {f['LastModified']}")
        else:
            print("No files found.")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    list_s3_pdfs()
