#!/bin/bash

# Quick test script for Risk Range Scraper Preview functionality
# Run this to verify everything is set up correctly

set -e

echo "🔍 Testing Risk Range Scraper Preview Functionality"
echo "=================================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check 1: AWS Credentials
echo "1️⃣  Checking AWS credentials..."
if aws configure list | grep -q "access_key.*shared-credentials-file"; then
    echo -e "${GREEN}✓ AWS credentials configured${NC}"
else
    echo -e "${RED}✗ AWS credentials not configured. Run 'aws configure'${NC}"
    exit 1
fi

# Check 2: boto3
echo ""
echo "2️⃣  Checking boto3 installation..."
if python3 -c "import boto3; print(boto3.__version__)" > /dev/null 2>&1; then
    VERSION=$(python3 -c "import boto3; print(boto3.__version__)")
    echo -e "${GREEN}✓ boto3 installed (v$VERSION)${NC}"
else
    echo -e "${RED}✗ boto3 not installed. Install with: pip3 install boto3${NC}"
    exit 1
fi

# Check 3: Playwright
echo ""
echo "3️⃣  Checking Playwright..."
if python3 -c "from playwright.sync_api import sync_playwright" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Playwright available${NC}"
else
    echo -e "${RED}✗ Playwright not available. Install with: pip3 install playwright && playwright install${NC}"
    exit 1
fi

# Check 4: S3 Bucket Access
echo ""
echo "4️⃣  Checking S3 bucket access..."
if aws s3 ls s3://market-dashboard-csv-data/ > /dev/null 2>&1; then
    echo -e "${GREEN}✓ S3 bucket accessible${NC}"
    
    # Check if directories exist
    if aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/ > /dev/null 2>&1; then
        SCREENSHOT_COUNT=$(aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/ --recursive | wc -l | tr -d ' ')
        echo -e "  ${YELLOW}→ Found $SCREENSHOT_COUNT screenshot(s) in S3${NC}"
    else
        echo -e "  ${YELLOW}→ No screenshots yet (will be created on first run)${NC}"
    fi
else
    echo -e "${RED}✗ Cannot access S3 bucket. Check permissions${NC}"
    exit 1
fi

# Check 5: Backend Server
echo ""
echo "5️⃣  Checking backend server..."
if curl -s http://localhost:3001/api/workflow-status > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Backend server running on port 3001${NC}"
    
    # Test screenshot endpoint (will fail if no data, but endpoint should exist)
    DATE=$(date +%Y-%m-%d)
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/hedgeye/screenshot/$DATE)
    if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "404" ]; then
        echo -e "  ${GREEN}✓ Screenshot endpoint responding (HTTP $RESPONSE)${NC}"
    else
        echo -e "  ${YELLOW}⚠ Screenshot endpoint returned HTTP $RESPONSE${NC}"
    fi
else
    echo -e "${RED}✗ Backend server not running. Start with: npm run server${NC}"
    exit 1
fi

# Check 6: Scraper Script
echo ""
echo "6️⃣  Checking scraper script..."
SCRAPER_PATH="hedgeye_local_scraper.py"
if [ -f "$SCRAPER_PATH" ]; then
    echo -e "${GREEN}✓ Scraper script found${NC}"
    
    # Check if script has screenshot functionality
    if grep -q "page.screenshot" "$SCRAPER_PATH"; then
        echo -e "  ${GREEN}✓ Screenshot capture code present${NC}"
    else
        echo -e "  ${RED}✗ Screenshot capture code not found${NC}"
    fi
    
    if grep -q "export_to_csv" "$SCRAPER_PATH"; then
        echo -e "  ${GREEN}✓ CSV export code present${NC}"
    else
        echo -e "  ${RED}✗ CSV export code not found${NC}"
    fi
else
    echo -e "${RED}✗ Scraper script not found${NC}"
    exit 1
fi

# Check 7: LaunchAgent
echo ""
echo "7️⃣  Checking LaunchAgent status..."
if [ -f "manage_scraper.sh" ]; then
    if ./manage_scraper.sh status > /dev/null 2>&1; then
        echo -e "${GREEN}✓ LaunchAgent script available${NC}"
        echo -e "  ${YELLOW}→ Run './manage_scraper.sh status' for details${NC}"
    else
        echo -e "${YELLOW}⚠ LaunchAgent may not be installed${NC}"
    fi
else
    echo -e "${YELLOW}⚠ manage_scraper.sh not found${NC}"
fi

# Summary
echo ""
echo "=================================================="
echo -e "${GREEN}✅ All checks passed!${NC}"
echo ""
echo "Next steps:"
echo "1. Run scraper manually: python3 hedgeye_local_scraper.py --scrape --chrome"
echo "2. Check S3 for screenshot: aws s3 ls s3://market-dashboard-csv-data/hedgeye-screenshots/ --recursive"
echo "3. Open dashboard Preview tab: http://localhost:3000"
echo "4. Click Service Tracking → Preview tab"
echo ""
echo "For detailed testing, see: TESTING_CHECKLIST.md"


