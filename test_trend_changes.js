// Test script to verify changelog endpoint DynamoDB query
const { AWS } = require('./src/services/aws/clients.cjs');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'us-west-1' });

async function testChangelogQuery() {
    console.log('\n=== Testing Changelog Query ===\n');

    const today = new Date();
    const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    console.log('Querying for date:', dateStr);

    try {
        const result = await dynamodb.get({
            TableName: 'HedgeyeDailySnapshot',
            Key: { date: dateStr, snapshotType: 'risk-ranges' }
        }).promise();

        const item = result.Item;

        if (!item) {
            console.log('❌ No snapshot found for today');
            return;
        }

        console.log('\n✅ Snapshot found');
        console.log('Fields:', Object.keys(item));
        console.log('\nHas trendChanges?', 'trendChanges' in item);

        if (item.trendChanges) {
            console.log('trendChanges length:', item.trendChanges.length);
            console.log('\nTREND Changes:');
            item.trendChanges.forEach((tc, i) => {
                console.log(`  ${i + 1}. ${tc.ticker}: ${tc.oldTrend} → ${tc.newTrend}${tc.note ? ' (' + tc.note + ')' : ''}`);
            });
        } else {
            console.log('❌ No trendChanges field');
        }

        // Now test what the changelog endpoint would do
        console.log('\n=== Simulating Changelog Logic ===');
        const recentSnapshots = [item]; // Simplified - assuming we found it
        const current = recentSnapshots[0];

        console.log('current.trendChanges exists?', !!current.trendChanges);
        console.log('Type:', typeof current.trendChanges);

        const results = {};
        results['risk-ranges'] = {
            added: [],
            removed: [],
            updates: [],
            currentDate: current.date,
            available: true
        };

        if (current.trendChanges) {
            console.log('✅ Adding trendChanges to results');
            results['risk-ranges'].trendChanges = current.trendChanges;
        } else {
            console.log('❌ trendChanges is falsy, not adding');
        }

        console.log('\nFinal results object has trendChanges?', 'trendChanges' in results['risk-ranges']);
        console.log('trendChanges length in results:', results['risk-ranges'].trendChanges ? results['risk-ranges'].trendChanges.length : 0);

    } catch (error) {
        console.error('Error:', error);
    }
}

testChangelogQuery();
