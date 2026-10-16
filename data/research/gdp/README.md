# GDP research records

The GDP card is fixed to 2026-Q3. Research records retain their measured quarter,
unit, source publication date, and reading target separately from contract prices.
The initial official references were checked against BEA and Atlanta Fed source
pages on September 9, 2026. The reviewed Hedgeye reference comes from its dated
August 31 publication; it is not claimed to be the latest forecast. Consensus
remains unavailable until a dated reviewed source is imported.

Import a reviewed forecast with:

```sh
node scripts/import_gdp_snapshot.cjs data/research/gdp/hedgeye-2026-08-31-reviewed.json --dry-run
node scripts/import_gdp_snapshot.cjs data/research/gdp/hedgeye-2026-08-31-reviewed.json
```

Use the reviewed JSON file as the schema example. Required fields are `kind`,
`sourceId` (`hedgeye` or `consensus`), `quarter` (`YYYY-QN`), `metric`
(`U.S. real GDP`), `unit` (`percent_qoq_saar`), numeric `value`, `modelType`,
`publishedAt`, HTTPS `sourceUrl`, `verifiedAt`, `reviewedAt`, and a focused `evidence`
excerpt that establishes the publication date, quarter, metric, and value.
Dates must be ISO dates or timestamps with an explicit timezone; missing dates
are rejected. Use `targetStage: null` and `surveyIdentity: null` when unknown.
Use `Enhanced Comparative Base Effects Model` as `modelType` for later Hedgeye
forecasts identified that way by the source. Never reconstruct QoQ SAAR from YoY.

BEA's schedule and current release, and Atlanta Fed's dated GDPNow headline,
refresh hourly while the monitor is used (five-minute retry after source failure).
Verified observations append to `records.jsonl`; identical observations deduplicate,
while revised values and release stages remain separate. Original verified research
remains visible with its source date during provider outages; it is never labeled
as an executable or live quote. The store is read on every monitor request, so a
reviewed import is picked up without a server restart.

The runtime ledger is local and gitignored, independently of the versioned reviewed
references. A fresh checkout loads both the official references and the reviewed
August 31 Hedgeye artifact even when no runtime ledger exists. The import command
adds later reviewed publications to the local ledger without editing those originals.

## Release-history card

The top chart selects quarters appearing in the last 12 publication months and
includes their complete release cycles, including earlier readings outside the
window. Every BEA vintage
retains its original measured quarter, stage and date; this is not a chart of
historical GDP values revised to today's vintage. Initial/Updated releases and
multiple publications in a month keep their official labels and dates. Annual
updates to quarters outside the displayed release cycle stay in the record store.
The contract generation remains Q3 2026 regardless of the historical bar selected.

Every quarter, including the two estimate quarters, has the same panel width and
divider. All bars use one width and release-slot spacing; a two-publication cycle
is centered in its panel. This is a categorical release sequence, not a continuous
month axis. Normal cycles reserve first/second/third slots. Verified upcoming
dates appear as Pending without a numeric value or bar. `release-notices.json`
provides sourced explanations for official delays, including October/November
2025's combined December initial release. Annual updates retain their own slots.

Two dashed bars to the right show dated Hedgeye forecasts for the contract quarter
and following quarter on the same QoQ SAAR scale. They do not enter BEA reading
history, revision calculations, or selected-print comparisons. Missing reviewed
quarterly forecasts stay blank. Clicking a forecast opens its source/model details.
The August 31 publication verifies Q3 at 4.02% (Nowcast) and Q4 at 1.46%
(Enhanced Comparative Base Effects Model). The Q4 reviewed artifact includes the
original chart URL and SHA-256 evidence hash; neither release target is confirmed.

`official-history.json` contains source-verified BEA vintages, five disjoint
component contributions from archived table 1.1.2, and original GDPNow
`TrackingArchives` publications. Each record carries its source URL, verification
date, and SHA-256 evidence hash. It includes no values from the illustrative design.
BEA component workbooks must match the selected quarter, publication date and
headline growth; a later revised time series cannot substitute for a first print.
Contributions use `percentage_points`; the GDP headline uses `percent_qoq_saar`.

The history loader runs separately once a day, preserving research during source
outages. It discovers current official workbook links and the public BEA archive,
then appends missing readings, forecasts and components to the existing ledger.
The current headline/schedule refresh cadence remains hourly. The first response
uses verified references while larger history workbooks load in the background.

Estimate ticks and surprise gaps require matching quarter/unit/release target and
a publication before the selected print. Same-day forecasts without a known time
are excluded. GDPNow values from its archive are rounded to its published headline
precision (one decimal percent); pseudo-real-time/reconstructed sheets are excluded.
Unknown Hedgeye targets and consensus survey identities remain explicitly unknown.
The component table compares first to latest contributions for the selected quarter.
A zero headline revision means unchanged at displayed precision, not identical
unrounded estimates or unchanged components.
