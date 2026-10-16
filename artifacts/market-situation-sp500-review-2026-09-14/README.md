# Market Situation Report — S&P 500 card review

Source: [Hedgeye, September 14, 2026](https://app.hedgeye.com/feed_items/187129), published at 6:30 a.m. EDT. The email's weekly plan covers September 14–18. This review covers the complete email and its six archived charts; the separate subscriber report requires Hedgeye login.

## Verified chart readings

All figures below are explicitly labeled on charts dated **September 11**, included in the September 14 report. They are report context, not live quotes.

| Field | Reading |
| --- | ---: |
| Gamma throttle | +0.08 |
| 10-day realized volatility | 10.74 |
| Gamma flip / zero gamma | 7,656 |
| Lower probable-volatility band | 7,512 |
| Upper probable-volatility band | 7,769 |
| Strikes in play | 7,550; 7,600; 7,650; 7,700; 7,750 |

The throttle chart names Tier1Alpha.com; the gamma/PV map names Intrinio/Tier1Alpha.com. The narrative rounds the PV boundaries to approximately 7,500–7,750; the card uses the exact chart labels and their original date.

## Useful next additions

1. **Dealer positioning thresholds:** the September 14 narrative says reclaiming 7,700 would make positioning more supportive, with stronger positive gamma above 7,750. These thresholds are distinct from the precise 7,656 flip line. Present them as dated source scenarios in the existing row's detail.
2. **Opposing systematic flows:** the source projects up to $8.5 billion of vol-control buying for September 14 in a flat market, or roughly $5 billion with a 1% SPX move, while CTA positioning is weakening. Retain the date and conditional wording; these are source estimates, not observed flows.
3. **September 18 expiration:** the source flags a steeper gamma curve ahead of monthly options expiration, which includes substantial quarterly positioning. A compact note can explain why a decline may generate stronger dealer hedging.
4. **Semiconductor spillover:** the source discusses leveraged ETF and swap hedging as an additional source of intraday index sensitivity. Keep this qualitative; the chart does not supply a verified current SPX flow amount.

The existing matrix already contains Gamma Exposure **Neutral**, Systematic Flow Risk **Neutral**, PV Risk/Reward **Neutral**, and Strategic Allocation **Risk On**. Keep their meanings separate. The current “Hedgeye Structure Breadth” label could be clarified in a subsequent copy review.

## Extraction repair

- The deployed ingestor used the older report schema and did not pass Market Situation images into OCR. A narrow parser/handler overlay enables the established chart OCR path.
- The previous strike-list regex could select an interleaved right-axis tick. The parser now associates the vertical strike list with its own column.
- A missing companion label no longer discards an independently verified throttle or flip level. Missing fields remain unavailable.
- Chart IDs, source labels and chart dates survive validation into the card. The original email archive key is preserved separately from chart archive keys.
- The existing zero-gamma row is labeled **GAMMA FLIP / PV BANDS**. Both numeric rows remain context only; scoring and execution controls are unchanged.

The September 14 stored snapshot was repaired from the original archived email and real chart OCR, preserving the publication and observation timestamps. The deployed package and prior snapshot are backed up under `~/Library/Application Support/market-dashboard/repairs/market-structure-2026-09-14`.

Validation: 104 focused JavaScript tests, the focused parent-card integration test, 19 parser regressions, five deployment-preservation tests, and the production build passed. ESLint had no errors and one existing unused-function warning in the monitor service.

The running card was verified showing +0.08 / 10.74 and Flip 7,656 / PV 7,512–7,769, both dated September 11. Full levels and the five strikes are included in the gamma row's hover detail. During verification, the local API had an independent automatic-restart cycle caused by slow health responses; it recovered enough to serve and display the corrected report.
