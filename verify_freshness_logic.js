
const testFreshness = (nowStr, lastUpdatedStr, label) => {
    const now = new Date(nowStr);
    const lastUpdated = new Date(lastUpdatedStr);
    const options = { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' };

    const today = now.toLocaleDateString('en-US', options);
    const dataDate = lastUpdated.toLocaleDateString('en-US', options);

    const hoursAgo = (now - lastUpdated) / (1000 * 60 * 60);

    let status;
    if (dataDate === today) {
        status = 'fresh/success';
    } else if (hoursAgo < 48) {
        status = 'stale/warning';
    } else {
        status = 'missing/error';
    }

    console.log(`Test: ${label}`);
    console.log(`Now (UTC):  ${nowStr}  -> (EST): ${now.toLocaleDateString('en-US', options)}`);
    console.log(`Data (UTC): ${lastUpdatedStr}  -> (EST): ${lastUpdated.toLocaleDateString('en-US', options)}`);
    console.log(`Result:     ${status} (${Math.round(hoursAgo)}h ago)`);
    console.log('---');
};

console.log('--- MARKET DATA FRESHNESS TEST (EST TIMEZONE) ---');

// The scenario where the previous fix failed:
testFreshness(
    '2026-01-21T17:18:00Z', // 12:18 PM EST on Jan 21
    '2026-01-21T02:04:00Z', // 9:04 PM EST on Jan 20 (Early morning UTC, late night EST)
    'Data from late last night EST'
);

testFreshness(
    '2026-01-21T17:18:00Z',
    '2026-01-21T13:00:00Z', // 8:00 AM EST on Jan 21
    'Data from this morning EST'
);

testFreshness(
    '2026-01-21T17:18:00Z',
    '2026-01-19T17:18:00Z',
    'Data from 48+ hours ago'
);
