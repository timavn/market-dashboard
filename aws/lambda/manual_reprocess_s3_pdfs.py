import boto3
import os
import sys
import shutil
from pathlib import Path
from datetime import datetime, timezone

# Add current directory to path for imports
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from date_utils import extract_date_from_pdf
from parse_bitcoin_tracker import extract_bitcoin_tracker, save_to_dynamodb as save_bitcoin
from parse_early_look import extract_early_look, save_to_dynamodb as save_early_look
from parse_portfolio_solutions import extract_portfolio_solutions, save_to_dynamodb as save_portfolio
from parse_momo_tracker import extract_momo_tracker, save_to_dynamodb as save_momo
from parse_signal_strength import extract_signal_strength, save_to_dynamodb as save_signal

def reprocess_latest_pdfs():
    s3 = boto3.client('s3', region_name='us-west-1')
    bucket = 'market-dashboard-csv-data'
    
    products = [
        'bitcoin-trend-tracker', 
        'portfolio-solutions', 
        'momo-tracker', 
        'signal-strength', 
        'early-look'
    ]
    
    print("Checking for recent PDFs in S3...")
    
    for product in products:
        prefix = f"hedgeye/{product}/"
        try:
            response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
            if 'Contents' not in response:
                print(f"No PDFs found for {product}")
                continue
                
            # Get latest file
            latest = sorted(response['Contents'], key=lambda x: x['LastModified'], reverse=True)[0]
            s3_key = latest['Key']
            print(f"\nProcessing latest {product}: {s3_key}")
            print(f"Timestamp: {latest['LastModified']}")
            
            # Download
            local_path = f"/tmp/{os.path.basename(s3_key)}"
            s3.download_file(bucket, s3_key, local_path)
            
            # Extract Date
            pdf_date = extract_date_from_pdf(local_path)
            print(f"Extracted Date: {pdf_date}")
            
            # Process
            data = None
            if product == 'bitcoin-trend-tracker':
                data = extract_bitcoin_tracker(local_path, s3_key=s3_key)
                if data: save_bitcoin(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
                
            elif product == 'portfolio-solutions':
                data = extract_portfolio_solutions(local_path, s3_key=s3_key)
                if data: save_portfolio(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
                
            elif product == 'momo-tracker':
                data = extract_momo_tracker(local_path, s3_key=s3_key)
                if data: save_momo(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
                
            elif product == 'signal-strength':
                data = extract_signal_strength(local_path, s3_key=s3_key)
                if data: save_signal(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
                
            elif product == 'early-look':
                data = extract_early_look(local_path)
                if data: save_early_look(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
                
        except Exception as e:
            print(f"Error processing {product}: {e}")

if __name__ == "__main__":
    reprocess_latest_pdfs()
