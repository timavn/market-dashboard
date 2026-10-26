# HedgAI research integration

HedgAI is a separate, shortest-term research layer. Its publisher book, historical
performance metrics, and dated email actions are independent of directional Trade,
Trend, live quotes, native contract odds, and executable order inputs.

## Evidence and replay

- Canonical Gmail code lives in `infra/lambdas/gmail_ingestor/`. The existing Hermes
  mailbox schedule discovers labeled Hedgeye mail; no additional scheduler is needed.
- `hedgai_signals.py` reads the four explicit action headings and separates headline
  reaffirmations. Marketing text, footer tickers, and performance promotion do not
  become new actions or metrics. `hedgai_instruments.json` preserves the reviewed
  publisher's instrument relationships, including yield identities.
- `ResearchEventLedgerV2` uses `productKey=hedgai-signals`. Each email emits one
  `HEDGAI_PUBLICATION` plus its `HEDGAI_ACTION` and `HEDGAI_REAFFIRMATION` records.
  A publication with zero actions still has durable evidence. Source sequence counts,
  content hashes, and verification hashes bind the complete delivered event group.
- The reviewed baseline is `data/research/hedgai/2026-09-28-baseline.json`, backed by
  eight hashed source images. Its `includedPublicationIds` includes `hedgai:187742`;
  that day's five actions remain evidence and are not applied again.
- Duplicate deliveries compare authenticated publication content independently of
  Gmail message IDs and archive locations; every delivery keeps its provenance.
  Missing or invalid publication times retain actions as unresolved evidence and
  cannot change the book, initiation dates, or current-day change list.
- After the original envelope hashes, sequence, identity, and action count pass
  verification, the projection can resolve a retained unparsed action heading
  through an exact `hedgai_instruments.json` label or alias. Its original
  `sourceText`, publication date, and source ID remain attached. The original
  diagnostic remains with resolved metadata; unknown labels, missing categories,
  conflicting actions, and other source discrepancies stay blocked. This does not
  rewrite ledger records or change archived publications.
- Metrics retain their own source date. Action emails do not update historical
  batting averages, win/loss ratios, thresholds, z-scores, or metrics dates.
- Portfolio and predictive-market consumers read the shared dated projection through
  `GET /api/research/hedgai?asOf=<timezone-bearing ISO timestamp>`.

## Reviewed baseline import

Preview validates the transcription and every archived image without cloud writes:

```sh
python3 infra/scripts/import_hedgai_baseline.py
```

After a source review, `--apply` uses the repository's verified administrator profile
to archive content-addressed evidence and append one `HEDGAI_BASELINE` event.
Existing objects and events are checked for equality rather than overwritten.
The initial baseline import has been read back: 47 rows and nine source objects
(eight screenshots and the baseline JSON). Email events are written by the Gmail
replay, not the baseline importer.

## September 28 deployment and validation

The production Lambda `market-dashboard-gmail-ingestor-v2` was updated using an
optimistic RevisionId lock and a six-file HedgAI-only overlay on the existing cloud
ZIP. All other deployed files and function configuration were preserved; local
unrelated changes were not uploaded. The original cloud ZIP, scoped diff, hashes,
deployment receipt, replay receipt, and read-back verification are retained in the
locally ignored `runtime/release-artifacts/hedgai-2026-09-28/` directory.

The exact September 28 archived email was replayed through the deployed parser.
Read-back verified seven immutable records, an indexed product manifest and Gmail
artifact, and a merged daily snapshot containing five actions plus the META
reaffirmation. Publication time is `2026-09-28T12:43:00+00:00`; the incorrect 2024
template teaser does not control publication dating. The replay had zero errors;
its overall attention status reflected nine unrelated pre-existing quarantines.

Validation at release: 138 relevant local ingestion tests passed, all nine focused
HedgAI tests passed against the staged cloud artifact, and comparison against 125
existing cloud compatibility tests introduced no new failures. Focused reruns:

```sh
python3 -m unittest infra.tests.test_hedgai_signals
python3 infra/scripts/test_import_hedgai_baseline.py
node --test src/services/hedgaiResearch.test.cjs src/routes/hedgaiResearch.test.cjs
```

Future repairs should target identified immutable artifacts and the deployed
materialization version. Do not reuse the September 28 release ZIP to deploy later
changes without obtaining the current cloud artifact and a new RevisionId lock.

## Analyst and market surfaces

- The main dashboard scans the full publisher book for Tick (`Ti`) readings,
  displaying published Buy, Short, and Wait states independently of the historical
  60% side qualification. Applicable index, commodity, rates, and currency
  references use structured mappings with the publisher's proxy instrument ID
  visible. Tick remains separate from Trade (`Ta`) and Trend (`Te`), with its own
  source and publication date.
- Portfolio Review captures HedgAI immediately before the existing Trade/Trend
  research. The 60% inclusive side filter yields XLE, UJB, SLX, XLY, SPY, and IWM
  from the initial book. The full-book disclosure retains all 47 states, both
  directional records, initiation dates, publisher groups, and statistics dates.
- Predictive Markets Review includes Kalshi Nasdaq-100 and a compact HedgAI
  reading for the five matching reviewed markets. The shared monitor row also
  supports verified WTI, Brent, and Russell mappings without adding score points.
- Research mappings preserve the publisher label and displayed ETF separately.
  Historical batting averages never become native contract settlement odds, and
  HedgAI does not change existing contract direction or quote availability.
- Saved review captures retain their own projection, settings, source records,
  mappings, and dates. Historical Portfolio and Predictive review responses were
  compared before and after integration and were exactly unchanged.

## Tick coverage and October 6 source repair

Tick (`Ti`) precedes Trade (`Ta`) and Trend (`Te`) in the existing research
labels. The shared Tick projection covers all 47 reviewed source-listed
instruments without applying the historical 60% strategy filter. Portfolio,
security details, Securities, and Top 10 + MOMO use that
same projection. Analyst holdings and prediction narratives likewise display
the explicit captured position independently of historical strategy eligibility;
saved reviews use only their own captured evidence. Explicit Wait is gray;
compact readings retain `Ti →` and full readings say `Wait`. The publisher defines
Wait and Watch as no directional call; it is not an independently published
Neutral forecast. The neutral arrow is the requested compact representation of
Wait, with that source meaning retained in the tooltip. Internal neutral styling must not change that source meaning,
and the sign of a within-threshold Z-score must not create a Tick direction.
Missing or unchecked research has no
invented direction. Structured overview references preserve the original model
label and source-listed instrument and never invert currency or yield readings.

The October 6 repair updates only the deployed `hedgai_signals.py` and
`hedgai_instruments.json`, using the current cloud ZIP and RevisionId. It reads
action values inside their original list-item boundaries, distinguishes verified
empty sections from missing sections, ignores image links, and recognizes the
publisher's `[CORRECTION]` subject prefix. The October 1 correction publication
(`hedgai:187942`) is imported as its own later publication.

`infra/scripts/reparse_hedgai_sources.py` verifies each archived HTML SHA and the
complete original event group before appending `HEDGAI_SOURCE_REPARSE` evidence.
The original ledger records remain unchanged. The projection validates the
repair's original event keys, hashes, publication identity, instrument catalog,
and source binding before using the reparsed headings. Unknown or conflicting
repairs continue to withhold the affected research.

The October 6 headline publishes five longs and seven shorts; the complete
archived action sequence reconstructs eight Buy and seven Short positions. Both
aggregates remain exact, with a nonblocking source discrepancy linked to that
publication. Independent instrument readings retain their dated evidence;
the discrepancy does not invent three closing actions or rewrite the publisher.
The current full-book PDF must be verified before this aggregate discrepancy can
be marked resolved.

Deployment, correction replay, append-only repair, and live projection receipts
are retained in `runtime/release-artifacts/hedgai-tick-2026-10-06/`.

The live API readback verifies all 47 instrument readings with complete
continuity and no blocking source issues. The front overview displays 17
applicable exact or explicitly labeled reference readings; Top 10 + MOMO
displays the covered company readings alongside its existing Trend. The
aggregate discrepancy is durably saved in the Analyst Inbox with the original
publication link. Background assessment preserved all four conversations and
all 19 prior acknowledgments. Portfolio row rendering is covered by focused
tests; the local Gateway outage prevents verification against fresh holdings.

The October 6 front overview has four bullish Tick cells (USD Index and UUP
share one published instrument, alongside Financials and Bitcoin), one bearish
cell (WTI), and twelve Wait cells. Its overview roster therefore has a larger
Wait share than the complete 47-security book. Wait on S&P 500, Russell 2000,
Nasdaq 100, and Copper follows explicit published closing actions; it is not a
missing-field fallback.

## Earlier layout verification

Portfolio Review uses one combined HedgAI table, with five relevant securities
per publisher group and the full 47-security book behind the disclosure. The
presentation catalog preserves readable security names separately from the exact
publisher labels and prioritizes Nasdaq, Gold, S&P 500, and Palladium before
qualified active signals and eligible market context. This is a display priority,
not a performance ranking or a change to the 60% eligibility rule. Wait and
excluded sides remain explicit. Today’s source actions sit beside their own
security instead of appearing as a separate prose list. Saved reviews use their
own captured research, dates, and presentation settings.

The running dashboard was checked for the six qualifying table rows, all 47
full-book rows, 25 gray Wait states, nine grouped source publications, five
predictive-market readings, Nasdaq's excluded Short, and the WTI monitor row.
All eight archived image URLs returned the exact original PNG hashes. Screenshots
and standalone captured Markdown exports are retained with the release receipts.

Focused parser, projector, importer, report, source-incident, and monitor tests
passed. Changed-file lint has no errors; existing warnings remain in shared
server/route files. The production build passed with its existing large-chunk
warning. Existing unrelated provider gaps and ingestion quarantines remain
separate from HedgAI research continuity.
