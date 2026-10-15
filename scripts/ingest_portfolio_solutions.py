
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

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / 'infra' / 'scripts'))
from aws_profile_contract import (  # noqa: E402
    ADMIN_PROFILE,
    AwsProfileContractError,
    pin_environment,
    verified_session,
)

def ingest_all(session):
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
            
            data = extract_portfolio_solutions(pdf_path_obj, session=session)
            
            if data and data.get('rankings'):
                save_to_dynamodb(data, pdf_date=pdf_date, session=session)
            else:
                print("  ❌ No data extracted or no rankings found.")
                
        except Exception as e:
            print(f"  ❌ Error processing {pdf_path}: {e}")

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description='Ingest Portfolio Solutions with the verified admin profile.')
    parser.add_argument('--admin-profile', required=True)
    args = parser.parse_args()
    if args.admin_profile != ADMIN_PROFILE:
        parser.error(f'--admin-profile must be {ADMIN_PROFILE}')
    try:
        aws_session = verified_session(args.admin_profile, purpose='admin', region='us-west-1')
    except AwsProfileContractError as error:
        parser.error(f'{error.error_code}: {error.detail}')
    pin_environment(args.admin_profile)
    ingest_all(aws_session)
