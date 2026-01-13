#!/bin/bash
# This script updates all parser save_to_dynamodb functions to use pdf_date parameter

echo "Updating all parsers to use PDF date instead of current date..."
echo "This ensures historical accuracy when reprocessing old PDFs"
echo ""

# List of parsers to update
PARSERS=(
    "parse_signal_strength.py"
    "parse_bitcoin_tracker.py"
    "parse_early_look.py"
    "parse_momo_tracker.py"
    "parse_portfolio_solutions.py"
    "parse_hedgeye_pdf.py"
)

for parser in "${PARSERS[@]}"; do
    if [ -f "$parser" ]; then
        echo "✓ Will update: $parser"
    else
        echo "✗ Not found: $parser"
    fi
done

echo ""
echo "Manual updates required in each file:"
echo "1. Import: from date_utils import extract_date_from_pdf"
echo "2. Extract date: pdf_date = extract_date_from_pdf(pdf_path)"
echo "3. Pass to save: save_to_dynamodb(data, s3_key, pdf_date)"
echo "4. In save_to_dynamodb: Change 'date = datetime.now()...' to 'date = pdf_date'"
