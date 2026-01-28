import sys
import os
import boto3

# Add lambda directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../aws/lambda')))

import csv_processor
from decimal import Decimal

def run_ingestion():
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
    # Ensure region is set
    os.environ['AWS_REGION'] = 'us-west-1'
    run_ingestion()
