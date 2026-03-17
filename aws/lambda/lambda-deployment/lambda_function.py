#!/usr/bin/env python3
"""
Lambda function to process Hedgeye PDFs uploaded to S3
Triggered by S3 PUT events on hedgeye/*.pdf

Workflow:
1. S3 PUT event triggers Lambda
2. Download PDF from S3 to /tmp/
3. Auto-detect PDF type and parse using appropriate parser
4. Extract date from PDF
5. Save data to DynamoDB HedgeyeDailySnapshot
6. Log processing results

Dependencies (Lambda Layer required):
- pdfplumber
- pdf2image
- PyPDF2
- boto3 (included in Lambda runtime)
- poppler-utils (binary, requires Lambda layer)
"""

import os
import json
import boto3
import tempfile
from pathlib import Path
from datetime import datetime, timezone

# Import shared parsing utilities
from date_utils import extract_date_from_pdf
from parse_bitcoin_tracker import extract_bitcoin_tracker, save_to_dynamodb as save_bitcoin
from parse_early_look import extract_early_look, save_to_dynamodb as save_early_look
from parse_portfolio_solutions import extract_portfolio_solutions, save_to_dynamodb as save_portfolio
from parse_momo_tracker import extract_momo_tracker, save_to_dynamodb as save_momo
from parse_signal_strength import extract_signal_strength, save_to_dynamodb as save_signal
from parse_the_call import extract_the_call, save_to_dynamodb as save_the_call

# Initialize AWS clients
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-west-1'))


def detect_pdf_type(filename):
    """Detect PDF type from filename"""
    filename_lower = filename.lower()

    if 'bitcoin' in filename_lower or 'btc' in filename_lower:
        return 'bitcoin-trend-tracker'
    elif 'early' in filename_lower or 'look' in filename_lower:
        return 'early-look'
    elif 'portfolio' in filename_lower or 'solution' in filename_lower:
        return 'portfolio-solutions'
    elif 'momo' in filename_lower or 'momentum' in filename_lower:
        return 'momo-tracker'
    elif 'signal' in filename_lower or 'strength' in filename_lower:
        return 'signal-strength'
    elif 'call' in filename_lower and ('hedgeye' in filename_lower or 'summary' in filename_lower or 'replay' in filename_lower):
        return 'the-call'
    else:
        return None


def lambda_handler(event, context):
    """
    Lambda handler for S3 PUT events on hedgeye/*.pdf

    Event structure:
    {
        "Records": [{
            "s3": {
                "bucket": {"name": "market-dashboard-csv-data"},
                "object": {"key": "hedgeye/bitcoin-tracker-2026-01-10.pdf"}
            }
        }]
    }
    """

    try:
        # Extract S3 event details
        record = event['Records'][0]
        bucket_name = record['s3']['bucket']['name']
        s3_key = record['s3']['object']['key']

        print(f"📄 Processing PDF from S3: s3://{bucket_name}/{s3_key}")

        # Detect PDF type from filename
        filename = Path(s3_key).name
        pdf_type = detect_pdf_type(filename)

        if not pdf_type:
            print(f"❌ Could not detect PDF type from filename: {filename}")
            return {
                'statusCode': 400,
                'body': json.dumps(f'Unknown PDF type: {filename}')
            }

        print(f"✅ Detected PDF type: {pdf_type}")

        # Download PDF from S3 to /tmp/
        temp_pdf_path = f"/tmp/{filename}"
        print(f"📥 Downloading PDF to {temp_pdf_path}...")
        s3.download_file(bucket_name, s3_key, temp_pdf_path)

        # Extract date from PDF
        pdf_date = extract_date_from_pdf(temp_pdf_path)
        print(f"📅 PDF Date: {pdf_date}")

        # Parse PDF based on type
        print(f"🔍 Parsing {pdf_type}...")

        if pdf_type == 'bitcoin-trend-tracker':
            data = extract_bitcoin_tracker(temp_pdf_path, s3_key=s3_key)
            if data and (data.get('cryptos') or data.get('stocks')):
                save_bitcoin(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
            else:
                print("❌ No data extracted from Bitcoin Tracker")

        elif pdf_type == 'early-look':
            data = extract_early_look(temp_pdf_path, s3_key=s3_key)
            if data:
                save_early_look(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
            else:
                print("❌ No data extracted from Early Look")

        elif pdf_type == 'portfolio-solutions':
            data = extract_portfolio_solutions(temp_pdf_path, s3_key=s3_key)
            if data:
                save_portfolio(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
            else:
                print("❌ No data extracted from Portfolio Solutions")

        elif pdf_type == 'momo-tracker':
            data = extract_momo_tracker(temp_pdf_path, s3_key=s3_key)
            if data:
                save_momo(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
            else:
                print("❌ No data extracted from Momo Tracker")

        elif pdf_type == 'signal-strength':
            data = extract_signal_strength(temp_pdf_path, s3_key=s3_key)
            if data:
                save_signal(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
            else:
                print("❌ No data extracted from Signal Strength")

        elif pdf_type == 'the-call':
            data = extract_the_call(temp_pdf_path, s3_key=s3_key)
            if data:
                save_the_call(data, pdf_s3_key=s3_key, pdf_date=pdf_date)
            else:
                print("❌ No data extracted from The Call")

        # Clean up temp file
        os.remove(temp_pdf_path)

        print(f"✅ Successfully processed {pdf_type} PDF")

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f'Successfully processed {pdf_type}',
                'pdf_type': pdf_type,
                'pdf_date': pdf_date,
                's3_key': s3_key
            })
        }

    except Exception as e:
        print(f"❌ Error processing PDF: {str(e)}")
        import traceback
        traceback.print_exc()

        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'traceback': traceback.format_exc()
            })
        }
