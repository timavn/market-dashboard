#!/bin/bash
# Test script for RiskRangeScraper Lambda function

FUNCTION_NAME="RiskRangeScraper"
REGION="${AWS_REGION:-us-west-1}"

echo "=========================================="
echo "Testing RiskRangeScraper Lambda Function"
echo "=========================================="
echo ""

# Test 1: Check function exists
echo "1. Checking if function exists..."
aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✓ Function exists"
else
    echo "❌ Function not found. Make sure the name is correct."
    exit 1
fi

# Test 2: Check function configuration
echo ""
echo "2. Function configuration:"
aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query '{Runtime:Runtime,Timeout:Timeout,MemorySize:MemorySize,Handler:Handler}' --output table

# Test 3: Check environment variables
echo ""
echo "3. Environment variables:"
aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" --query 'Environment.Variables' --output table

# Test 4: Invoke function
echo ""
echo "4. Invoking function..."
echo "   This may take a few minutes..."
RESPONSE_FILE="/tmp/risk_range_test_response.json"
aws lambda invoke \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --payload '{}' \
    "$RESPONSE_FILE" \
    --log-type Tail \
    --query 'LogResult' \
    --output text | base64 -d

echo ""
echo "5. Function response:"
if [ -f "$RESPONSE_FILE" ]; then
    cat "$RESPONSE_FILE" | python3 -m json.tool 2>/dev/null || cat "$RESPONSE_FILE"
    echo ""
else
    echo "❌ No response file created"
fi

# Test 5: Check CloudWatch logs
echo ""
echo "6. Recent CloudWatch logs (last 50 lines):"
echo "   Run this command to see full logs:"
echo "   aws logs tail /aws/lambda/$FUNCTION_NAME --follow --region $REGION"
echo ""
echo "=========================================="
echo "Test complete!"
echo "=========================================="


