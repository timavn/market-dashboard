const AWS = require('aws-sdk');

// Configure AWS
AWS.config.update({
    region: 'us-west-1'
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

async function verifyMomoOrder() {
    try {
        console.log('🔍 Verifying Momo Tracker data in DynamoDB...');

        const params = {
            TableName: 'HedgeyeDailySnapshot',
            FilterExpression: 'snapshotType = :type',
            ExpressionAttributeValues: {
                ':type': 'momo-tracker'
            }
        };

        const result = await dynamodb.scan(params).promise();

        if (!result.Items || result.Items.length === 0) {
            console.log('❌ No Momo Tracker data found in DynamoDB');
            return;
        }

        // Sort by date descending
        const sortedSnapshots = result.Items.sort((a, b) => new Date(b.date) - new Date(a.date));
        const latest = sortedSnapshots[0];

        console.log('Found snapshots:', sortedSnapshots.map(s => s.date).join(', '));
        console.log(`📅 Latest Snapshot Date: ${latest.date}`);
        console.log(`📊 Stock Count: ${latest.stockCount}`);

        if (!latest.data) {
            console.log('❌ No data object in snapshot');
            return;
        }

        const items = Object.entries(latest.data).map(([ticker, data]) => ({
            ticker,
            ...data
        }));

        // Check if index exists
        const missingIndex = items.filter(i => i.index === undefined);
        if (missingIndex.length > 0) {
            console.log(`❌ Found ${missingIndex.length} items missing 'index' field`);
        } else {
            console.log('✅ All items have `index` field');
        }

        // Sort by index and print all
        const sorted = items.sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

        console.log('\n🔝 All Items (Visual Order):');
        sorted.forEach(item => {
            console.log(`   [${item.index}] ${item.ticker} (${item.buyTrade}/${item.sellTrade})`);
        });

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

verifyMomoOrder();
