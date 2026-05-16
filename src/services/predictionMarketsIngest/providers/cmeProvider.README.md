# CME Direct API Replacement

Production CME event-contract metadata is available via:

- [CME Reference Data API](https://www.cmegroup.com/trading/market-tech-and-data-services/cme-reference-data-api.html) — filter `subtype=EVENT`, attribute `fixPayout`
- MDP 3.0 / Smart Stream — commercial market-data agreements required

To enable a direct feed (instead of IBKR-routed discovery):

1. Obtain CME credentials and add to AWS Secrets Manager
2. Set `CME_DIRECT_API_ENABLED=true`
3. Implement `fetchCmeDirect()` in `cmeProvider.js` and map fields to `normalizeEvent(..., 'cme')`

Until then, `fetchCMEEvents()` returns IBKR-discovered CME EC instruments when Gateway is online.
