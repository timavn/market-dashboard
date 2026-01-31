import sys
import os
import pdfplumber
from pathlib import Path

def main():
    # Target file: Mag7 (-3.1%)
    target_name = "Hedgeye - MOMO Tracker _ Mag7 (-3.1%), NVDA=BEARISH, QQQ=BEARISH, AMZN at TREND, VIX→ ”only the 5th time”.pdf"
    momo_dir = Path(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../dashboard/hedgeye/momotracker')))
    pdf_path = momo_dir / target_name
    
    if not pdf_path.exists():
        print(f"File not found: {pdf_path}")
        # List dir to help debug
        print(f"Contents of {momo_dir}:")
        for f in momo_dir.glob("*"):
            print(f.name)
        sys.exit(1)

    print(f"Extracting text from: {pdf_path}")
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) > 0:
            text = pdf.pages[0].extract_text()
            print("--- Page 1 Text ---")
            print(text)
            print("--- End Page 1 ---")
        else:
            print("PDF has no pages.")

if __name__ == "__main__":
    main()
