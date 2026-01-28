const axios = require('axios');

const BASE_URL = 'http://localhost:3001/api/performance';

async function testEndpoint(name, url) {
    try {
        console.log(`Testing ${name} (${url})...`);
        const start = Date.now();
        const response = await axios.get(url);
        const duration = Date.now() - start;

        if (response.status === 200) {
            console.log(`✅ ${name} SUCCESS (${duration}ms)`);

            // Basic validation
            const data = response.data;
            if (name === 'Equity Curve') {
                console.log(`   - Data points: ${data.values?.length}`);
                if (!data.values || data.values.length === 0) console.warn('   ⚠️ No values returned');
            } else if (name === 'Metrics') {
                console.log(`   - Sharpe: ${data.sharpeRatio}`);
            } else if (name === 'Statements') {
                console.log(`   - Count: ${data.statements?.length}`);
            }
            return true;
        } else {
            console.error(`❌ ${name} FAILED: Status ${response.status}`);
            return false;
        }
    } catch (error) {
        console.error(`❌ ${name} FAILED: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data: ${JSON.stringify(error.response.data)}`);
        }
        return false;
    }
}

async function runTests() {
    console.log('Starting API Verification...');

    // We need to wait a moment for the server to restart if the user restarted it, 
    // BUT I am running this on the EXISTING server. 
    // If the user hasn't restarted, the code change won't be picked up by the server process (Node.js).
    // The user MUST restart the server for my changes to performance.js to take effect.
    // However, I can't force them. 
    // IF the server is running with nodemon, it would restart.
    // package.json says "server": "node server.js". 
    // So it will NOT restart automatically.

    // Validating against the OLD code will likely fail with 500 again.
    // Validating against the NEW code requires a restart.

    // I will try to run the tests. If they fail, it confirms the restart is needed.
    // If they pass... then maybe I was wrong about node caching or they used nodemon mentally?

    const results = await Promise.all([
        testEndpoint('History', `${BASE_URL}/history`),
        testEndpoint('Equity Curve', `${BASE_URL}/equity-curve`),
        testEndpoint('Metrics', `${BASE_URL}/metrics?period=all`),
        testEndpoint('Statements', `${BASE_URL}/statements`)
    ]);

    const passed = results.filter(r => r).length;
    console.log(`\nTests Completed: ${passed}/${results.length} Passed`);
}

runTests();
