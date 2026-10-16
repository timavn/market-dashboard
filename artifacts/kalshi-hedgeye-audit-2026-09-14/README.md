**Hedgeye spot ranges versus Kalshi perpetuals — historical audit, September 14, 2026**

The evidence supports the same underlying assets and, after normalizing Kalshi API units, the same dollar price scale. It does not establish that Hedgeye levels are interchangeable with precise executable Kalshi prices. The historical checks found three timing/price inconsistencies that remain unresolved, rather than a clear case of a completely wrong underlying. No strategy profitability or predictive accuracy was tested.

This corrects the earlier implication that matching asset names and units were sufficient to apply the ranges directly.

The audit retrieved 53,219 Kalshi minute-candle records: September 1–14 for Bitcoin and Ether; September 10–14 for gold and silver; and morning windows on 11 additional August crypto report dates. It also inspected 65 archived primary Hedgeye report dates from June 1–September 4, 15 complete August–September archived Crypto Quant reports, and nine current September emails from each product. Older January Crypto Quant records were excluded from the Kalshi comparisons. Sources, retrieval URLs, raw candles and sensitivity data are in the accompanying evidence archive.

The historical endpoint used was the actual perpetual endpoint, `/margin/markets/{ticker}/candlesticks`, not binary prediction-market prices. [Kalshi candle documentation](https://docs.kalshi.com/margin-rest/market/get-market-candlesticks)

**Instrument identity and price units**

Hedgeye's primary reports explicitly label GOLD, SILVER and BITCOIN as spot prices. Crypto Quant's original September 4 charts label its BTC series `XBTUSD Curncy` and ETH series `XETUSD Curncy`. The metals reports do not identify an exact benchmark feed or close methodology. Hedgeye's reference to Bloomberg CFIX concerns the headline overnight percentage calculation; it does not establish that the premarket price or risk-range calculation uses CFIX. [Hedgeye public sample](https://app.hedgeye.com/samples/risk-range-signals.html), [Crypto Quant methodology note](https://app.hedgeye.com/insights/104885-free-today-crypto-quant-bitcoin-trend-tracker)

| Kalshi market | Hedgeye underlying | Actual API contract size | Normalize API dollars by dividing by | Resulting price units |
|---|---|---:|---:|---|
| KXGOLDPERP | GOLD spot | 0.001 troy ounce | 0.001 | USD/troy ounce |
| KXSILVERPERP | SILVER spot | 0.1 troy ounce | 0.1 | USD/troy ounce |
| KXBTCPERP | BTC / BITCOIN spot | 0.0001 BTC | 0.0001 | USD/BTC |
| KXETHPERP | ETH spot | 0.001 ETH | 0.001 | USD/ETH |

These sizes come from the September 14 API response. Earlier filings describe larger base contracts with fractional units. Their base contract sizes must not be substituted for the current API's `contract_size`. [Kalshi market documentation](https://docs.kalshi.com/margin-rest/market/get-market), [current public market endpoint](https://external-api.kalshi.com/trade-api/v2/margin/markets)

Gold and silver reference Pyth; crypto references CF Benchmarks. Kalshi's own traded price, bid, ask, reference price, settlement mark and liquidation mark are separate fields. Its filings also permit settlement based on contract trades or book observations rather than an identity with the spot index. [Gold filing](https://www.cftc.gov/filings/ptc/ptc09082624176.pdf), [Silver filing](https://www.cftc.gov/filings/ptc/ptc09082624183.pdf), [Bitcoin filing](https://www.cftc.gov/filings/ptc/ptc0602265036.pdf)

**Historical attempts to falsify the match**

For 20 Crypto Quant report dates, August 7–September 14, I compared both reported spot prices with actual normalized Kalshi trade extrema. Hedgeye discloses a usual collection time around 06:00 EST, plus or minus 30 minutes, with exceptions. Because summer reports also use EDT, the conservative comparison window is 09:30–11:30 UTC (05:30–07:30 EDT), capped at the printed publication time. No subsequent day's report was used. Null trade observations were excluded rather than filled with previous prices.

Of the 40 observations, 37 fell within the corresponding Kalshi trade envelope; three did not:

| Report | Asset | Hedgeye reported price | Kalshi trades in comparison window | Minimum distance outside envelope | Distance / Hedgeye band width |
|---|---|---:|---:|---:|---:|
| Aug. 7 | BTC | $64,517 | $64,754–$64,946 | $237 (0.367%) | 7.16% |
| Aug. 7 | ETH | $1,904 | $1,908.70–$1,916.00 | $4.70 (0.247%) | 4.09% |
| Sept. 3 | ETH | $2,407 | $2,388.80–$2,405.10 | $1.90 (0.079%) | 1.03% |

The August 7 window ends at 07:09 EDT, the report's printed publication minute. September 3 ends at 07:30 EDT. Original source images were visually checked for all three anomalies. [August 7 report](https://app.hedgeye.com/feed_items/185666), [September 3 report](https://app.hedgeye.com/feed_items/186750)

August 7 also fails a quote check across the wider 09:30–11:30 UTC window: the lowest BTC bid was $64,750, and the lowest ETH bid was $1,908.50. The reported figures therefore were not simply untraded prices sitting inside the observed quote range.

Timing sensitivity prevents attributing these gaps to benchmark basis. Expanding August 7 backward to 04:00 EDT includes both report prices: the BTC price lies inside the trade range of the minute ending 04:43 EDT, and the last observed exact ETH trade at $1,904 is in the minute ending 04:23 EDT. Those precede the earliest assumed window by 47 and 67 minutes. On September 3, expanding forward to publication includes an ETH high of $2,410.30. These are plausible timing explanations, not proof of the actual collection times. The original three exceptions remain flagged.

The 37 compatible envelopes are not a 92.5% accuracy rate. They do not prove a contemporaneous matching quote, a trade at the exact reported price, or zero tracking error. Median comparison-window movement was approximately 0.628% for BTC and 0.707% for ETH; sizable instantaneous differences could be hidden within those windows. Exact observation timestamps are necessary for a stricter test.

As a separate internal check, all 15 overlapping archived August–September BTC reports have identical low/high ranges in Daily Risk Range and Crypto Quant. Their price columns differ because the daily report gives a previous close while Crypto Quant gives a premarket observation. Those differences must not be called Kalshi tracking errors.

**Trading-price differences that the data does establish**

These are the normalized spreads between minute-end Kalshi bids and asks. They measure quoted execution friction, not the difference from Hedgeye or the oracle:

| Asset | Median spread | 95th percentile | Largest observed spread |
|---|---:|---:|---:|
| Gold | $0.80/oz | $1.80/oz | $17.10/oz |
| Silver | $0.016/oz | $0.033/oz | $0.202/oz |
| BTC | $3/BTC | $6/BTC | $180/BTC |
| ETH | $0.10/ETH | $0.30/ETH | $43.70/ETH |

Two invalid gold minute-end quotes were excluded; zero bids and the enormous empty-ask sentinel were not treated as market prices. The largest crypto spreads occurred in minutes without trades, so they are not demonstrated fills or realized slippage. The $17.10 gold spread on September 10 was 8.5% of that day's $201 Hedgeye band width, illustrating why an exact boundary order needs the actual book.

Twelve separate September 14 API snapshots also showed distinct book and reference prices: gold book prices ranged from reference +$0 to +$1.60, silver from −$0.003 to +$0.027, BTC from −$9 to +$7, and ETH from −$0.60 to +$0.30. Reference and mark timestamps differ slightly and bid/ask fields lack individual timestamps, so these are same-response comparisons, not exact synchronized historical basis measurements. These small sampled differences do not establish a persistent or material discrepancy.

**Limits specific to metals and the dashboard**

The actual metal trade history begins September 10, so the available sample includes only a few days and one weekend. Gold traded $4,334.70–$4,358.80 and silver $64.263–$64.659 between Friday September 11 at 17:00 ET and Sunday at 18:00 ET. These are actual perpetual trade ranges; no exact historical oracle series was available to turn them into a measured basis. [Kalshi launch announcement](https://kalshi.com/pro/updates/perpetuals-gold-silver)

The filings permit a held reference when its market is closed or its feed is stale. Pyth's standard metal feed documentation follows CME hours, but the exact feed designated for Kalshi's continuous gold contract was not established. Substituting a convenient Pyth or COMEX history would not provide a valid exact comparison. Pyth's historical API requires authentication. [Pyth market-hours explanation](https://docs.pyth.network/price-feeds/pro/faq), [Pyth historical API](https://docs.pyth.network/price-feeds/pro/api/history)

The inspected local dashboard snapshots still stop at September 4, while September 14 emails exist. For example, stored silver was $63–$69 versus the new $60–$65. The research gold alias `GLD` is spot gold, not a GLD ETF share price. Stored midnight publication timestamps also discard the report's actual printed publication time. These issues would invalidate a naive comparison or use of retained research as today's range; they are separate from whether the underlying mapping is correct.

The supported interpretation is underlying spot research on the correct dollar scale. Precise Kalshi execution-level equivalence remains unvalidated. To measure it, obtain the exact Hedgeye source observations and timestamps, the exact designated Kalshi oracle history, and simultaneous Kalshi bid/ask; then quantify differences in dollars and as a fraction of the day's band, including cases where they lie on opposite sides of a boundary. A band breach by itself would test neither instrument identity nor profitability.

No dashboard code, provider configuration, orders or runtime data were changed. Only these audit artifacts were added; unrelated pre-existing working-tree changes were left intact.
