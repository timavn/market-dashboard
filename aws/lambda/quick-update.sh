#!/bin/bash
# Quick script to update just the Python file in the existing zip
# Much faster than rebuilding everything

ZIP_FILE="hedgeye_risk_range_scraper.zip"
PYTHON_FILE="hedgeye_risk_range_scraper.py"

if [ ! -f "$ZIP_FILE" ]; then
    echo "❌ $ZIP_FILE not found. Download it from S3 first:"
    echo "   aws s3 cp s3://risk-range-scraper/$ZIP_FILE ."
    exit 1
fi

echo "📝 Updating $PYTHON_FILE in $ZIP_FILE..."

# Create temp directory
TEMP_DIR=$(mktemp -d)

# Extract zip
unzip -q "$ZIP_FILE" -d "$TEMP_DIR"

# Copy updated Python file
cp "$PYTHON_FILE" "$TEMP_DIR/"

# Recreate zip
cd "$TEMP_DIR"
zip -q -r "../$ZIP_FILE" .
cd ..

# Cleanup
rm -rf "$TEMP_DIR"

echo "✅ Updated! Upload with:"
echo "   aws s3 cp $ZIP_FILE s3://risk-range-scraper/$ZIP_FILE"
echo "   aws lambda update-function-code --function-name RiskRangeScraper --s3-bucket risk-range-scraper --s3-key $ZIP_FILE"


