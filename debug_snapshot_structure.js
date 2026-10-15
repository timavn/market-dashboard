
const { AWS } = require('./src/services/aws/clients.cjs');
AWS.config.update({ region: 'us-west-1' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function debugSnapshots() {
    const types = ['risk-ranges', 'early-look']; // Check both, user likely meant Risk Ranges given the tickers

    for (const type of types) {
        console.log(`\n=== DEBUGGING: ${type} ===`);
        try {
            // Fetch specifically the Jan 20 and Jan 21 records
            // We manually fetch to be sure of what we are looking at
            const dates = ['2026-01-21', '2026-01-20'];

            for (const date of dates) {
                const params = {
                    TableName: 'HedgeyeDailySnapshot',
                    Key: { date: date, snapshotType: type }
                };
                const result = await dynamodb.get(params).promise();

                if (!result.Item) {
                    console.log(`[${date}] NO DATA FOUND`);
                    continue;
                }

                const dataKeys = result.Item.data ? Object.keys(result.Item.data) : [];
                console.log(`[${date}] Found ${dataKeys.length} keys in 'data' object.`);

                // Print 'SPX' and 'RUT' specifically to check for existence/formatting
                const spxMatch = dataKeys.find(k => k.toUpperCase().includes('SPX'));
                const rutMatch = dataKeys.find(k => k.toUpperCase().includes('RUT'));

                console.log(`   - Keys Sample: ${dataKeys.slice(0, 5).join(', ')}...`);
                console.log(`   - Contains 'SPX'? ${spxMatch ? `YES ("${spxMatch}")` : 'NO'}`);
                console.log(`   - Contains 'RUT'? ${rutMatch ? `YES ("${rutMatch}")` : 'NO'}`);

                // Also check if "data" is not an object but something else?
                // Or if the structure is nested deeper?
                if (type === 'early-look') {
                    // Early look usually has themes as keys?
                }
            }
        } catch (err) {
            console.error("Error:", err);
        }
    }
}

debugSnapshots();
