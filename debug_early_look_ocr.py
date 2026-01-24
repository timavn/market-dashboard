
import pdfplumber
import sys

if __name__ == "__main__":
    path = "/Users/timsmith/Desktop/hedgeye/riskranges/Hedgeye - JANUARY 21, 2026.pdf" 
    
    print(f"Reading: {path}")
    try:
        with pdfplumber.open(path) as pdf:
            if len(pdf.pages) < 1:
                print("No pages")
            else:
                page = pdf.pages[0]
                text = page.extract_text()
                print("--- PAGE 1 TEXT START ---")
                print(text)
                print("--- PAGE 1 TEXT END ---")
    except Exception as e:
        print(f"Error: {e}")
