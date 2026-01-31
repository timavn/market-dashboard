
import sys
import os
import glob
from pathlib import Path

# Add lambda directory to path
lambda_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '../aws/lambda'))
sys.path.append(lambda_path)

try:
    from parse_portfolio_solutions import extract_portfolio_solutions, save_to_dynamodb
    from date_utils import extract_date_from_pdf
except ImportError as e:
    print(f"Error importing modules: {e}")
    sys.exit(1)

def ingest_all():
    pdf_dir = "/Users/timsmith/Desktop/dashboard/hedgeye/portfoliosolutions"
    pdf_files = glob.glob(os.path.join(pdf_dir, "*.pdf"))
    
    print(f"Found {len(pdf_files)} PDF files.")
    
    # Sort by filename (which has date) to ensure chronological order if needed
    pdf_files.sort()
    
    for pdf_path in pdf_files:
        print(f"\nProcessing: {pdf_path}")
        try:
            pdf_path_obj = Path(pdf_path)
            pdf_date = extract_date_from_pdf(pdf_path_obj)
            print(f"  Date: {pdf_date}")
            
            data = extract_portfolio_solutions(pdf_path_obj)
            
            if data and data.get('rankings'):
                save_to_dynamodb(data, pdf_date=pdf_date)
            else:
                print("  ❌ No data extracted or no rankings found.")
                
        except Exception as e:
            print(f"  ❌ Error processing {pdf_path}: {e}")

if __name__ == "__main__":
    # Ensure region is set
    os.environ['AWS_REGION'] = 'us-west-1'
    ingest_all()
