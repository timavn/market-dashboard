#!/bin/bash
#
# Create Hedgeye Data Warehouse Tables in DynamoDB
# Professional schema with date-first organization
#
# Usage: ./create_hedgeye_tables.sh [--region us-west-1]

set -euo pipefail

REGION="${1:-us-west-1}"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

info "Creating Hedgeye Data Warehouse tables in region: ${REGION}"
echo ""

# Table 1: HedgeyeRiskRanges
info "Creating table: HedgeyeRiskRanges"
aws dynamodb create-table \
    --table-name HedgeyeRiskRanges \
    --attribute-definitions \
        AttributeName=date,AttributeType=S \
        AttributeName=ticker,AttributeType=S \
    --key-schema \
        AttributeName=date,KeyType=HASH \
        AttributeName=ticker,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Project,Value=MarketDashboard Key=DataSource,Value=Hedgeye \
    --region ${REGION} \
    2>/dev/null && info "✓ HedgeyeRiskRanges created" || warn "Table may already exist"

# Create GSI for ticker-based queries
info "Adding TickerIndex GSI to HedgeyeRiskRanges..."
aws dynamodb update-table \
    --table-name HedgeyeRiskRanges \
    --attribute-definitions \
        AttributeName=ticker,AttributeType=S \
        AttributeName=date,AttributeType=S \
    --global-secondary-index-updates \
        "[{\"Create\":{\"IndexName\":\"TickerIndex\",\"KeySchema\":[{\"AttributeName\":\"ticker\",\"KeyType\":\"HASH\"},{\"AttributeName\":\"date\",\"KeyType\":\"RANGE\"}],\"Projection\":{\"ProjectionType\":\"ALL\"},\"ProvisionedThroughput\":{\"ReadCapacityUnits\":5,\"WriteCapacityUnits\":5}}}]" \
    --region ${REGION} \
    2>/dev/null && info "✓ TickerIndex GSI added" || warn "GSI may already exist"

echo ""

# Table 2: HedgeyeSignalStrength
info "Creating table: HedgeyeSignalStrength"
aws dynamodb create-table \
    --table-name HedgeyeSignalStrength \
    --attribute-definitions \
        AttributeName=date,AttributeType=S \
        AttributeName=rank,AttributeType=N \
    --key-schema \
        AttributeName=date,KeyType=HASH \
        AttributeName=rank,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Project,Value=MarketDashboard Key=DataSource,Value=Hedgeye \
    --region ${REGION} \
    2>/dev/null && info "✓ HedgeyeSignalStrength created" || warn "Table may already exist"

echo ""

# Table 3: HedgeyeMacroNotes
info "Creating table: HedgeyeMacroNotes"
aws dynamodb create-table \
    --table-name HedgeyeMacroNotes \
    --attribute-definitions \
        AttributeName=date,AttributeType=S \
        AttributeName=noteType,AttributeType=S \
    --key-schema \
        AttributeName=date,KeyType=HASH \
        AttributeName=noteType,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Project,Value=MarketDashboard Key=DataSource,Value=Hedgeye \
    --region ${REGION} \
    2>/dev/null && info "✓ HedgeyeMacroNotes created" || warn "Table may already exist"

echo ""

# Table 4: HedgeyeCallNotes
info "Creating table: HedgeyeCallNotes"
aws dynamodb create-table \
    --table-name HedgeyeCallNotes \
    --attribute-definitions \
        AttributeName=date,AttributeType=S \
        AttributeName=callId,AttributeType=S \
    --key-schema \
        AttributeName=date,KeyType=HASH \
        AttributeName=callId,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Project,Value=MarketDashboard Key=DataSource,Value=Hedgeye \
    --region ${REGION} \
    2>/dev/null && info "✓ HedgeyeCallNotes created" || warn "Table may already exist"

echo ""

# Table 5: HedgeyeDailySnapshot
info "Creating table: HedgeyeDailySnapshot"
aws dynamodb create-table \
    --table-name HedgeyeDailySnapshot \
    --attribute-definitions \
        AttributeName=date,AttributeType=S \
        AttributeName=snapshotType,AttributeType=S \
    --key-schema \
        AttributeName=date,KeyType=HASH \
        AttributeName=snapshotType,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Project,Value=MarketDashboard Key=DataSource,Value=Hedgeye \
    --region ${REGION} \
    2>/dev/null && info "✓ HedgeyeDailySnapshot created" || warn "Table may already exist"

echo ""
info "Waiting for tables to become ACTIVE..."
sleep 5

# Verify all tables exist
info "Verifying tables..."
for table in HedgeyeRiskRanges HedgeyeSignalStrength HedgeyeMacroNotes HedgeyeCallNotes HedgeyeDailySnapshot; do
    status=$(aws dynamodb describe-table --table-name ${table} --region ${REGION} --query 'Table.TableStatus' --output text 2>/dev/null || echo "MISSING")
    if [ "$status" == "ACTIVE" ]; then
        info "✓ ${table}: ${status}"
    else
        warn "✗ ${table}: ${status}"
    fi
done

echo ""
info "================================================"
info "Hedgeye Data Warehouse Setup Complete!"
info "================================================"
info ""
info "Tables created:"
info "  • HedgeyeRiskRanges       - Daily risk range signals"
info "  • HedgeyeSignalStrength   - Ranked signal strength list"
info "  • HedgeyeMacroNotes       - Macro show summaries"
info "  • HedgeyeCallNotes        - Research call notes"
info "  • HedgeyeDailySnapshot    - Daily rollup for quick queries"
info ""
info "Estimated cost: ~$0.50/year (essentially free!)"
info ""
info "Next steps:"
info "  1. Update scrapers to use new schema"
info "  2. Run: ./migrate_risk_range_data.sh"
info "  3. Build additional scrapers (signals, macro, calls)"
