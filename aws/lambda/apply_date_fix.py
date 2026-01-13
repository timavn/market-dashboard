#!/usr/bin/env python3
"""
Apply date extraction fix to all Hedgeye parsers
This ensures PDFs are archived with their publication date, not processing date
"""

import re
from pathlib import Path


def add_import_to_file(filepath):
    """Add date_utils import to parser file"""
    content = filepath.read_text()

    # Check if import already exists
    if 'from date_utils import extract_date_from_pdf' in content:
        print(f"   ✓ Import already exists in {filepath.name}")
        return False

    # Add import after other imports
    pattern = r'(from pathlib import Path)\n'
    replacement = r'\1\nfrom date_utils import extract_date_from_pdf\n'

    new_content = re.sub(pattern, replacement, content)

    if new_content != content:
        filepath.write_text(new_content)
        print(f"   ✓ Added import to {filepath.name}")
        return True
    else:
        print(f"   ✗ Could not add import to {filepath.name}")
        return False


def update_save_function(filepath):
    """Update save_to_dynamodb to accept pdf_date parameter"""
    content = filepath.read_text()

    # Pattern 1: Add pdf_date parameter
    pattern1 = r'def save_to_dynamodb\(data, pdf_s3_key=None\):'
    replacement1 = r'def save_to_dynamodb(data, pdf_s3_key=None, pdf_date=None):'

    # Pattern 2: Use pdf_date instead of datetime.now()
    pattern2 = r"date = datetime\.now\(timezone\.utc\)\.strftime\('%Y-%m-%d'\)"
    replacement2 = r"date = pdf_date if pdf_date else datetime.now(timezone.utc).strftime('%Y-%m-%d')"

    new_content = content
    new_content = re.sub(pattern1, replacement1, new_content)
    new_content = re.sub(pattern2, replacement2, new_content)

    if new_content != content:
        filepath.write_text(new_content)
        print(f"   ✓ Updated save_to_dynamodb in {filepath.name}")
        return True
    else:
        print(f"   - No changes needed in {filepath.name}")
        return False


def update_main_block(filepath):
    """Update __main__ block to extract and pass pdf_date"""
    content = filepath.read_text()

    # Find the pattern where save_to_dynamodb is called
    # Pattern varies by parser type

    # For parsers that call save_to_dynamodb with data only
    pattern1 = r'(    data = extract_\w+\(pdf_path[^\)]*\)\n\n    if data[^\n]*:\n        save_to_dynamodb\(data\))'
    replacement1 = (
        r'    pdf_date = extract_date_from_pdf(pdf_path)\n'
        r'    print(f"📅 PDF Date: {pdf_date}\\n")\n\n'
        r'\1'
    )

    # Replace save_to_dynamodb(data) with save_to_dynamodb(data, pdf_date=pdf_date)
    pattern2 = r'save_to_dynamodb\(data\)'
    replacement2 = r'save_to_dynamodb(data, pdf_date=pdf_date)'

    # Replace save_to_dynamodb(data, s3_key) with save_to_dynamodb(data, s3_key, pdf_date)
    pattern3 = r'save_to_dynamodb\(data, s3_key\)'
    replacement3 = r'save_to_dynamodb(data, s3_key, pdf_date)'

    new_content = content

    # Add pdf_date extraction if not already present
    if 'pdf_date = extract_date_from_pdf' not in content:
        # Add after the print header line
        header_pattern = r'(    print\("="\\*70\)\n\n)'
        header_replacement = r'\1    pdf_date = extract_date_from_pdf(pdf_path)\n    print(f"📅 PDF Date: {pdf_date}\\n")\n\n'
        new_content = re.sub(header_pattern, header_replacement, new_content)

    # Update function calls
    new_content = re.sub(pattern2, replacement2, new_content)
    new_content = re.sub(pattern3, replacement3, new_content)

    if new_content != content:
        filepath.write_text(new_content)
        print(f"   ✓ Updated __main__ block in {filepath.name}")
        return True
    else:
        print(f"   - No changes needed in __main__ block of {filepath.name}")
        return False


def main():
    """Apply date fix to all parsers"""
    lambda_dir = Path(__file__).parent

    parsers = [
        'parse_signal_strength.py',
        'parse_bitcoin_tracker.py',
        'parse_momo_tracker.py',
        'parse_portfolio_solutions.py',
        'parse_early_look.py',
        'parse_hedgeye_pdf.py'
    ]

    print("="*70)
    print("APPLYING DATE EXTRACTION FIX TO ALL PARSERS")
    print("="*70)

    for parser_name in parsers:
        parser_path = lambda_dir / parser_name

        if not parser_path.exists():
            print(f"\n✗ {parser_name} not found")
            continue

        print(f"\n📄 {parser_name}")

        # Step 1: Add import
        add_import_to_file(parser_path)

        # Step 2: Update save_to_dynamodb function
        update_save_function(parser_path)

        # Step 3: Update __main__ block
        update_main_block(parser_path)

    print("\n" + "="*70)
    print("✅ Date extraction fix applied to all parsers!")
    print("="*70)


if __name__ == '__main__':
    main()
