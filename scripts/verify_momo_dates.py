import sys
import os
from pathlib import Path
from datetime import date, timedelta
import glob

# Add lambda dir to path to import date_utils
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../aws/lambda')))

try:
    from date_utils import extract_date_from_pdf
except ImportError as e:
    print(f"Error importing date_utils: {e}")
    print("Trying to confirm sys.path:")
    for p in sys.path:
        print(p)
    sys.exit(1)

def get_trading_days(start_date, end_date):
    days = []
    current = start_date
    holidays = [
        date(2026, 1, 1),  # New Year's
        date(2026, 1, 19), # MLK Day
    ]
    while current <= end_date:
        # 0=Monday, 4=Friday, 5=Saturday, 6=Sunday
        if current.weekday() < 5 and current not in holidays:
            days.append(current)
        current += timedelta(days=1)
    return days

import re
import pdfplumber

def robust_extract_date(pdf_path):
    """
    Custom extraction to avoid picking up the print header date (e.g. 1/30/26, 7:42 AM).
    Looks for the publication timestamp which usually includes time and timezone, e.g. "01/21/26 08:17AM EST".
    """
    try:
        with pdfplumber.open(pdf_path) as pdf:
            if len(pdf.pages) >= 1:
                text = pdf.pages[0].extract_text()
                
                # Try specific publication format first: MM/DD/YY HH:MMAM EST
                # Example: 01/21/26 08:17AM EST
                match = re.search(r'(\d{1,2}/\d{1,2}/\d{2,4})\s+\d{1,2}:\d{2}[AP]M\s+EST', text)
                if match:
                    d_str = match.group(1)
                    # Convert to YYYY-MM-DD
                    parts = d_str.split('/')
                    month, day, year = int(parts[0]), int(parts[1]), int(parts[2])
                    if year < 100: year += 2000
                    return f"{year:04d}-{month:02d}-{day:02d}"
                
                # Fallback to standard Textract/user logic if not found, 
                # but be careful of the header.
                # If we didn't find the EST pattern, maybe try ignoring the first few lines?
                # Or just use the original extract_date_from_pdf as fallback.
                return extract_date_from_pdf(pdf_path)
    except Exception as e:
        print(f"Error reading PDF {pdf_path.name}: {e}")
        return None

def main():
    # Adjust path to point to usage location
    # Script is in cursor/market-dashboard/scripts/
    # Momo dir is cursor/market-dashboard/scripts/../../../dashboard/hedgeye/momotracker
    momo_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../dashboard/hedgeye/momotracker')))
    
    if not momo_dir.exists():
        print(f"Directory not found: {momo_dir}")
        sys.exit(1)

    print(f"Checking directory: {momo_dir}")
    pdf_files = list(momo_dir.glob("*.pdf"))
    print(f"Found {len(pdf_files)} PDF files.")

    found_dates = set()
    date_to_file = {}
    
    for pdf in pdf_files:
        try:
            # extract_date_from_pdf might print to stdout, identifying what it found
            d_str = robust_extract_date(pdf)
            if d_str:
                d = date.fromisoformat(d_str)
                found_dates.add(d)
                if d not in date_to_file:
                    date_to_file[d] = []
                date_to_file[d].append(pdf.name)
            else:
                print(f"Could not extract date from: {pdf.name}")
        except Exception as e:
            print(f"Error processing {pdf.name}: {e}")

    today = date(2026, 1, 30) # Fixed to verify consistently with current time context
    start_of_year = date(2026, 1, 1)
    
    expected_days = get_trading_days(start_of_year, today)
    
    missing_days = []
    for d in expected_days:
        if d not in found_dates:
            missing_days.append(d)

    print("\n--- Report ---")
    if not missing_days:
        print("Success: A download exists for every trading day YTD (thru Jan 30).")
    else:
        print(f"Missing downloads for {len(missing_days)} days:")
        for d in missing_days:
            print(f" - {d.strftime('%Y-%m-%d (%A)')}")
            
    print("\n--- File Counts per Day ---")
    for d, files in sorted(date_to_file.items()):
        if len(files) > 1:
            print(f"{d}: {len(files)} files")
        # Optional: Print checking which file maps to which date
        # print(f"{d}: {files[0]}")

if __name__ == "__main__":
    main()
