
const axios = require('axios');

async function fetchYahooQuote(yahooTicker) {
    try {
        const url = `https://query2.finance.yahoo.com/v7/finance/quote`;
        const params = {
            symbols: yahooTicker
        };

        console.log(`[Yahoo Finance] Fetching quote for: ${yahooTicker}`);

        const response = await axios.get(url, {
            params,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            timeout: 10000
        });

        console.log('Response status:', response.status);
        console.log('Response data:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error(`Error:`, error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data:`, JSON.stringify(error.response.data).substring(0, 500));
        }
    }
}

fetchYahooQuote('^GSPC');
