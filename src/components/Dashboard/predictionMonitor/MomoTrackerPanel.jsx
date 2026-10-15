import React from 'react';
import { currentMomoSpot, newYorkDateKey, isFiniteMomoTrackerValue as finite } from './momoTrackerContext';
import { currentSp500Contributors, currentSp500ContributorQuote, isSp500RegularSession, supplementalMomoRows } from './sp500ContributorsContext';
import { MOMO_EXCLUDED_TICKERS } from '../../../constants/momoTrackerCatalog.cjs';
import './MomoTrackerPanel.css';
import DashboardResearchLabel from '../DashboardResearchLabel';
import useHedgaiTickResearch from '../../../hooks/useHedgaiTickResearch';
import { useSurfaceActivity } from '../../common/PersistentSurface';

const formatMomoLevel = (value) => finite(value)
  ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
  : '—';

const formatMomoPercent = (value, signed = false) => finite(value)
  ? `${signed && Number(value) > 0 ? '+' : ''}${Number(value).toFixed(2)}%`
  : '—';

const formatMarketCap = (value) => {
  if (!finite(value) || Number(value) <= 0) return '—';
  const divisor = Number(value) >= 1e12 ? 1e12 : 1e9;
  return `$${(Number(value) / divisor).toFixed(2)}${divisor === 1e12 ? 'T' : 'B'}`;
};

const quoteLabel = (quote) => {
  if (!quote) return 'UNAVAILABLE';
  if (quote.status === 'last-close') return `LAST CLOSE ${quote.marketDate?.slice(5).replace('-', '/')}`;
  if (quote.status === 'delayed') {
    const time = new Date(quote.asOf).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return `DELAYED ${time} ET`;
  }
  return 'LIVE';
};

const quoteDescription = (quote) => quote
  ? `${quoteLabel(quote)} · ${quote.source} · Observed ${quote.asOf}${quote.marketDate ? ` · Market date ${quote.marketDate}` : ''}${quote.status === 'last-close' && quote.delayedSource ? ' · DELAYED SOURCE' : ''}`
  : 'UNAVAILABLE';

const directionClass = (value) => !finite(value) || Number(value) === 0
  ? 'is-neutral' : Number(value) > 0 ? 'is-positive' : 'is-negative';

const INDEX_WEIGHT_DESCRIPTION = 'Percentage of the S&P 500 index by float-adjusted index weight. The ten largest S&P 500 companies are displayed in descending company market cap order, with Alphabet represented by GOOGL. Company market cap includes shares that may not be in the index weighting.';

const MomoTrackerPanel = ({
  contributors,
  snapshot,
  spots = {},
  state = 'loading',
  nowMs = Date.now(),
}) => {
  const active = useSurfaceActivity();
  const { readings: tickReadings } = useHedgaiTickResearch({ active });
  const rankedContributors = currentSp500Contributors(contributors, nowMs);
  const available = Boolean(rankedContributors);
  const loading = !available && contributors?.status === 'loading';
  const currentPublication = ['available', 'refresh-delayed'].includes(state)
    && snapshot?.status === 'available'
    && snapshot?.publicationDate === newYorkDateKey(nowMs);
  const ranges = new Map((currentPublication ? snapshot.rows : []).map((row) => [row.ticker, row]));
  const displayedContributors = (rankedContributors?.rows || [])
    .filter((row) => !MOMO_EXCLUDED_TICKERS.includes(row.ticker))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const supplementalRows = supplementalMomoRows(currentPublication ? snapshot.rows : [], displayedContributors)
    .map(({ ticker }) => rankedContributors?.supplementalRows?.find((row) => row.ticker === ticker)
      || { ticker, name: ticker })
    .sort((a, b) => (b.marketCap?.value ?? 0) - (a.marketCap?.value ?? 0)
      || a.ticker.localeCompare(b.ticker));
  const rows = [...displayedContributors, ...supplementalRows];
  const tableLabel = 'S&P 500 contributors and supplemental MOMO risk ranges';

  return (
    <aside
      className={`pm-spx-momo-tracker is-${available ? 'available' : loading ? 'loading' : 'unavailable'}`}
      aria-label={tableLabel}
      aria-busy={loading || undefined}
      data-testid="sp500-momo-tracker"
    >
      {available ? (
        <div className="pm-spx-momo-tracker-table-scroll">
          <table aria-label={tableLabel}>
            <colgroup>
              <col className="is-rank" />
              <col className="is-ticker" />
              <col className="is-cap" />
              <col className="is-weight" />
              <col className="is-level" />
              <col className="is-spot" />
              <col className="is-day" />
              <col className="is-level" />
              <col className="is-percent" />
              <col className="is-percent" />
              <col className="is-trend" />
            </colgroup>
            <thead>
              <tr className="pm-spx-momo-tracker-columns">
                <th aria-label="Rank">#</th>
                <th>TICKER</th>
                <th title="Total company market capitalization in US dollars. The top ten S&P 500 companies come first, followed by additional current MOMO names, with each group sorted highest first.">MKT CAP</th>
                <th title={INDEX_WEIGHT_DESCRIPTION}>S&P %</th>
                <th className="is-buy">BUY TRADE</th>
                <th>SPOT</th>
                <th title="Share-price percentage change from the previous official session close, from the quoted provider. This is not the contribution to the index's daily return.">DAY %</th>
                <th className="is-sell">SELL TRADE</th>
                <th>UPSIDE</th>
                <th>DOWNSIDE</th>
                <th title="Tick / Trend" aria-label="Tick / Trend">Ti / Te</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((contributor) => {
                const row = ranges.get(contributor.ticker);
                const referenceQuote = currentSp500ContributorQuote(contributor.quote, nowMs);
                const liveSpot = isSp500RegularSession(nowMs) && referenceQuote?.status !== 'last-close'
                  ? currentMomoSpot(spots?.[contributor.ticker], nowMs) : null;
                const quote = liveSpot || referenceQuote;
                const cap = contributor.marketCap;
                const capDescription = cap
                  ? `${contributor.name} · Total company market cap · ${cap.source} · ${cap.timestampKind === 'retrieved' ? `Retrieved ${cap.fetchedAt || cap.asOf}` : `As of ${cap.asOf}`}`
                  : 'Market cap unavailable';
                const rangeDescription = row
                  ? `Hedgeye MOMO Tracker · ${snapshot.publicationDate}`
                  : 'No current Hedgeye MOMO Tracker range for this share class';
                const outbucket = row?.rangeStatus === 'outbucket'
                  ? `OUTBUCKET${row.rangeStatusDate ? ` ${row.rangeStatusDate}` : ''}` : null;
                const trend = ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(row?.trend) ? row.trend : null;
                return (
                  <tr key={contributor.ticker}>
                    <td className="is-rank" title={contributor.rank ? undefined : 'Supplemental MOMO Tracker coverage; outside the ten largest S&P 500 companies'}>{contributor.rank || '—'}</td>
                    <th scope="row" title={contributor.name}>{contributor.ticker}</th>
                    <td className={cap ? undefined : 'is-unavailable'} title={capDescription}>
                      {cap ? <a href={cap.sourceUrl} target="_blank" rel="noopener noreferrer">{formatMarketCap(cap.value)}</a> : '—'}
                    </td>
                    <td title={finite(contributor.weightPct) ? `${INDEX_WEIGHT_DESCRIPTION} ${rankedContributors.source} · As of ${rankedContributors.asOf}.` : 'No verified index weight available'}>{formatMomoPercent(contributor.weightPct)}</td>
                    <td className={outbucket ? 'is-outbucket' : !row ? 'is-unavailable' : undefined} title={`${rangeDescription}${outbucket ? ` · ${outbucket}` : ''}`}>
                      {outbucket || formatMomoLevel(row?.buyTrade)}
                    </td>
                    <td
                      className={`is-spot${quote ? '' : ' is-unavailable'}`}
                      title={quoteDescription(quote)}
                      aria-label={quote
                        ? `${contributor.ticker} ${quote.status === 'live' ? 'verified live' : quote.status} spot ${formatMomoLevel(quote.price)}`
                        : `${contributor.ticker} spot unavailable`}
                    >
                      <span>{quote ? formatMomoLevel(quote.price) : '—'}</span>
                    </td>
                    <td className={directionClass(quote?.changePercent)} title={quoteDescription(quote)}>{formatMomoPercent(quote?.changePercent, true)}</td>
                    <td className={outbucket ? 'is-outbucket' : !row ? 'is-unavailable' : undefined} title={`${rangeDescription}${outbucket ? ` · ${outbucket}` : ''}`}>
                      {outbucket || formatMomoLevel(row?.sellTrade)}
                    </td>
                    <td className={finite(row?.upside) ? 'is-upside' : 'is-unavailable'} title={rangeDescription}>{formatMomoPercent(row?.upside)}</td>
                    <td className={finite(row?.downside) ? 'is-downside' : 'is-unavailable'} title={rangeDescription}>{formatMomoPercent(row?.downside)}</td>
                    <td className={`is-trend is-${trend ? trend.toLowerCase() : 'unavailable'}`} title={rangeDescription}>
                      <div className={tickReadings[contributor.ticker]?.tickEvidence ? 'pm-spx-momo-signals' : undefined}>
                        <DashboardResearchLabel label={contributor.ticker} reading={tickReadings[contributor.ticker]} showName={false} />
                        <span>{trend || '—'}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pm-spx-momo-tracker-state" role="status">
          <span>{loading ? 'LOADING' : 'UNAVAILABLE'}</span>
        </div>
      )}
    </aside>
  );
};

export default MomoTrackerPanel;
