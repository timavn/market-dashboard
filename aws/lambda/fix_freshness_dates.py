#!/usr/bin/env python3
"""
Fix Freshness Dates - Re-process all Hedgeye PDFs to extract correct content dates

This script scans all PDF files in ~/Desktop/hedgeye/, extracts the correct 
publication date from each PDF header, and re-processes them to update DynamoDB
with the actual document dates instead of the processing dates.
"""

import sys
from pathlib import Path
from date_utils import extract_date_from_pdf

# Import all the parsers
from parse_hedgeye_pdf import extract_all_risk_range_data as extract_risk_ranges, save_to_dynamodb as save_risk_ranges
from parse_early_look import extract_early_look, save_to_dynamodb as save_early_look
from parse_bitcoin_tracker import extract_bitcoin_tracker, save_to_dynamodb as save_bitcoin_tracker
from parse_momo_tracker import extract_momo_tracker, save_to_dynamodb as save_momo_tracker
from parse_signal_strength import extract_signal_strength, save_to_dynamodb as save_signal_strength
from parse_portfolio_solutions import extract_portfolio_solutions, save_to_dynamodb as save_portfolio_solutions


def process_pdf(pdf_path, data_type):
    """
    Process a single PDF file and update DynamoDB with correct date
    
    Args:
        pdf_path: Path to the PDF file
        data_type: One of: risk-ranges, early-look, bitcoin-tracker, momo-tracker, signal-strength, portfolio-solutions
    """
    print(f"\n{'='*70}")
    print(f"Processing: {pdf_path.name}")
    print(f"Type: {data_type}")
    print(f"{'='*70}")
    
    # Extract the correct publication date from the PDF
    pdf_date = extract_date_from_pdf(pdf_path)
    
    if not pdf_date:
        print(f"❌ Could not extract date from PDF. Skipping.")
        return False
    
    print(f"📅 Extracted date: {pdf_date}")
    
    try:
        # Process based on data type
        if data_type == 'risk-ranges':
            data = extract_risk_ranges(str(pdf_path))
            if data:
                save_risk_ranges(data, pdf_date=pdf_date)
                
        elif data_type == 'early-look':
            data = extract_early_look(str(pdf_path))
            if data:
                save_early_look(data, pdf_date=pdf_date)
                
        elif data_type == 'bitcoin-tracker':
            data = extract_bitcoin_tracker(str(pdf_path))
            if data:
                save_bitcoin_tracker(data, pdf_date=pdf_date)
                
        elif data_type == 'momo-tracker':
            data = extract_momo_tracker(str(pdf_path))
            if data:
                save_momo_tracker(data, pdf_date=pdf_date)
                
        elif data_type == 'signal-strength':
            data = extract_signal_strength(str(pdf_path))
            if data:
                save_signal_strength(data, pdf_date=pdf_date)
                
        elif data_type == 'portfolio-solutions':
            data = extract_portfolio_solutions(str(pdf_path))
            if data:
                save_portfolio_solutions(data, pdf_date=pdf_date)
        
        print(f"✅ Successfully processed and saved with date: {pdf_date}")
        return True
        
    except Exception as e:
        print(f"❌ Error processing PDF: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Main function to process all PDFs"""
    hedgeye_dir = Path.home() / 'Desktop' / 'dashboard' / 'hedgeye'
    
    if not hedgeye_dir.exists():
        print(f"❌ Hedgeye directory not found: {hedgeye_dir}")
        sys.exit(1)
    
    print("\n" + "="*70)
    print("🚀 FIX FRESHNESS DATES - RE-PROCESS ALL HEDGEYE PDFs")
    print("="*70)
    print(f"\nScanning: {hedgeye_dir}\n")
    
    # Define the mapping of subdirectories to data types
    data_type_mapping = {
        'riskranges': 'risk-ranges',
        'earlylook': 'early-look',
        'bitcointracker': 'bitcoin-tracker',
        'momotracker': 'momo-tracker',
        'signalstrength': 'signal-strength',
        'portfoliosolutions': 'portfolio-solutions'
    }
    
    stats = {
        'total': 0,
        'success': 0,
        'failed': 0,
        'skipped': 0
    }
    
    # Process each subdirectory
    for subdir, data_type in data_type_mapping.items():
        subdir_path = hedgeye_dir / subdir
        
        if not subdir_path.exists():
            print(f"⚠️  Directory not found: {subdir_path}")
            continue
        
        # Find all PDFs in this subdirectory
        pdf_files = sorted(subdir_path.glob("*.pdf"))
        
        if not pdf_files:
            print(f"⚠️  No PDFs found in: {subdir}")
            continue
        
        print(f"\n{'='*70}")
        print(f"📁 {subdir.upper()} ({len(pdf_files)} PDFs)")
        print(f"{'='*70}")
        
        # Process the most recent PDF for each type
        # (or all PDFs if you want to process everything)
        for pdf_file in pdf_files[-1:]:  # Change to pdf_files to process all
            stats['total'] += 1
            
            if process_pdf(pdf_file, data_type):
                stats['success'] += 1
            else:
                stats['failed'] += 1
    
    # Print summary
    print(f"\n{'='*70}")
    print("📊 SUMMARY")
    print(f"{'='*70}")
    print(f"Total PDFs processed: {stats['total']}")
    print(f"✅ Successful: {stats['success']}")
    print(f"❌ Failed: {stats['failed']}")
    print(f"⚠️  Skipped: {stats['skipped']}")
    print(f"\n{'='*70}")
    print("✨ COMPLETE!")
    print(f"{'='*70}\n")


if __name__ == '__main__':
    main()
