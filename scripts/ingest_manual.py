import sys
import os
from pathlib import Path

# Add lambda directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../aws/lambda')))

from decimal import Decimal

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'infra' / 'scripts'))
from aws_profile_contract import (  # noqa: E402
    ADMIN_PROFILE,
    AwsProfileContractError,
    pin_environment,
    verified_session,
)

def run_ingestion(session):
    import csv_processor

    csv_processor.s3_client = session.client('s3')
    csv_processor.dynamodb = session.resource('dynamodb')
    print("Starting manual ingestion...")
    
    # 1. Ingest Positions (12-30-2025 Statement)
    # Note: User said 12-30-2025 statement.
    positions_file = '/Users/timsmith/Desktop/dashboard/performance/currentpositions/Individual-Positions-2026-01-27-213120.csv'
    
    # Wait, the filename says 2026-01-27. The user provided a 12-30 statement text but the file found is from today (2026-01-27).
    # The user said: "I have my individual positions from 12-30-25... I placed it in the folder listed in the screenshot"
    # But later: "Current Positions CSV is much better... Please download... for today".
    # And Step 223: "I havent uploaded the CSVs... you need to grab them... The image is what i see"
    # The file found `Individual-Positions-2026-01-27-213120.csv` implies it was downloaded TODAY.
    # This is GOOD. It means we have the "Current Positions" anchor.
    # The reconstruction works backward from "Current".
    # So I should use this file.
    
    print(f"Reading Positions CSV: {positions_file}")
    with open(positions_file, 'r', encoding='utf-8') as f:
        positions_content = f.read()
        
    print("Parsing Positions CSV...")
    portfolio_data = csv_processor.parse_schwab_csv(positions_content)
    
    # Use today's date for 'trading_date' since the filename has today's date
    trading_date = '2026-01-27' 
    
    print("Storing Portfolio Snapshot...")
    snapshot_id = csv_processor.store_portfolio_snapshot(portfolio_data)
    csv_processor.store_holdings(snapshot_id, portfolio_data['holdings'])
    
    # Store initial performance datapoint for today/anchor
    csv_processor.store_performance_data(trading_date, portfolio_data, snapshot_id)
    csv_processor.store_position_performance_data(trading_date, portfolio_data['holdings'])
    
    print("Positions Ingested Successfully.")
    
    # 2. Ingest Transactions (YTD)
    transactions_file = '/Users/timsmith/Desktop/dashboard/performance/transactions/Individual_XXX197_Transactions_20260128-022915.csv'
    # Date in filename is 20260128 (tomorrow? Timezone diff? or just very recent).
    
    print(f"Reading Transactions CSV: {transactions_file}")
    with open(transactions_file, 'r', encoding='utf-8') as f:
        transactions_content = f.read()
        
    print("Parsing Transactions CSV...")
    transactions = csv_processor.parse_schwab_transactions_csv(transactions_content)
    
    print(f"Found {len(transactions)} transactions.")
    
    print("Running Backward Reconstruction...")
    # This function calls store_performance_data for historical dates
    success = csv_processor.process_transaction_history(transactions)
    
    # Store transactions for plotting
    csv_processor.store_transactions(transactions)
    
    if success:
        print("History Reconstruction Complete!")
    else:
        print("History Reconstruction Failed.")

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Manually ingest legacy portfolio files with the verified admin profile.')
    parser.add_argument('--admin-profile', required=True)
    args = parser.parse_args()
    if args.admin_profile != ADMIN_PROFILE:
        parser.error(f'--admin-profile must be {ADMIN_PROFILE}')
    try:
        aws_session = verified_session(args.admin_profile, purpose='admin', region='us-west-1')
    except AwsProfileContractError as error:
        parser.error(f'{error.error_code}: {error.detail}')
    pin_environment(args.admin_profile)
    run_ingestion(aws_session)
