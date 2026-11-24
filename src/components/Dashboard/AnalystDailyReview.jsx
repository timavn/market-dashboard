import React from 'react';
import './AnalystDailyReview.css';

// The Daily Review: the day's wrap-up sheet, emitted by the review as one ```analyst-daily-review JSON block.
// Every figure is computed by the review service from its own captures; this file only lays them out.
// A value the review could not establish arrives as null and shows as N/A, never as zero.

const BLOCK = /```analyst-daily-review\n([\s\S]*?)\n```/;

export function parseDailyReview(text) {
  const match = BLOCK.exec(String(text || ''));
  if (!match) return null;
  try {
    const sheet = JSON.parse(match[1]);
    return sheet && sheet.version === 1 && sheet.headline && sheet.pnl && sheet.exposure ? sheet : null;
  } catch {
    return null;
  }
}

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const NA = 'N/A';
const whole = value => Math.round(Math.abs(value)).toLocaleString('en-US');
const money = value => (isNum(value) ? `${Math.round(value) < 0 ? '−' : ''}$${whole(value)}` : NA);
const signedMoney = value => (isNum(value) ? `${Math.round(value) > 0 ? '+' : Math.round(value) < 0 ? '−' : ''}$${whole(value)}` : NA);
const signedPct = (value, digits = 2) => (isNum(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%` : NA);
const pct = (value, digits = 0) => (isNum(value) ? `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%` : NA);
const bps = value => (isNum(value) ? `${Math.round(value) > 0 ? '+' : Math.round(value) < 0 ? '−' : ''}${Math.abs(Math.round(value))} bp` : NA);
const price = value => (isNum(value) ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 }) : NA);
const level = value => (isNum(value) ? value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 }) : NA);
// Long reads green and short red, as signed numbers do everywhere on the site.
const sideTone = side => (side === 'short' ? 'is-negative' : 'is-positive');
const tone = value => (!isNum(value) || Math.round(value * 100) === 0 ? '' : value > 0 ? ' is-positive' : ' is-negative');

const pacific = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const stamp = value => {
  const time = new Date(value);
  return value && Number.isFinite(time.getTime()) ? `${pacific.format(time).replace(',', '')} PT` : null;
};
const day = value => (/^\d{4}-\d{2}-\d{2}$/.test(value || '')
  ? new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) : NA);

const SESSION = { 'post-market': 'After the close', open: 'Market open', 'pre-market': 'Pre-market', closed: 'Market closed' };
const BASIS = { 'ibkr-account': 'IBKR account daily P&L', positions: 'Sum of position and trading P&L',
  'positions-partial': 'Sum of position and trading P&L; the positions named below are left out' };
const PCT_BASIS = { 'prior-close-nlv': 'On NLV at the previous close', nlv: 'As a share of current NLV' };
// Short names keep each market cell on one line at the report's width.
const MARKET_LABEL = { NDX: 'Nasdaq', RUT: 'Russell', USD: 'Dollar', CL: 'WTI', UST2Y: '2Y', UST10Y: '10Y' };
const KALSHI_STATE = { CLOSED: 'Closed', CONTRADICTS: 'Contradicts', THROUGH_LINE: 'Through line', SETUP_LAPSED: 'Unshaded', CLOSING: 'Closing', HOLD: 'Hold' };

const Figure = ({ label, value, valueTone = '', title }) => <div className="analyst-daily__figure" title={title}>
  <dt>{label}</dt><dd className={valueTone.trim()}>{value}</dd>
</div>;

// A ruled grid of label/value cells with a fixed number of columns. Every cell gives its label the same width
// (labelWidth, sized to the grid's longest label), so labels and values line up down the grid, and blank cells
// square off the last row.
function Cells({ columns, label, labelWidth, className = '', children }) {
  const cells = React.Children.toArray(children);
  const blanks = (columns - (cells.length % columns)) % columns;
  return <dl className={`analyst-daily__cells ${className}`.trim()} style={{ '--analyst-daily-columns': columns, '--analyst-daily-label': labelWidth }} aria-label={label}>
    {cells}{Array.from({ length: blanks }, (_, index) => <div key={`blank-${index}`} className="analyst-daily__figure is-blank" aria-hidden="true"><dt /><dd /></div>)}
  </dl>;
}

const Card = ({ title, note, children, wide = false }) => <section className={`analyst-daily__card${wide ? ' is-wide' : ''}`} aria-label={title}>
  <h3>{title}{note && <small>{note}</small>}</h3>
  {children}
</section>;

const Table = ({ label, columns, rows, empty, className = '' }) => (rows.length ? <table className={`analyst-daily__table ${className}`.trim()} aria-label={label}>
  <thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
  <tbody>{rows}</tbody>
</table> : <p className="analyst-daily__empty">{empty}</p>);

const Cell = ({ value, valueTone = '', title }) => <td className={valueTone.trim() || undefined} title={title}>{value}</td>;

function Movers({ label, rows }) {
  return <Table label={label} className="is-movers" columns={[label, 'P&L', 'NLV', 'Day', 'Weight']} empty="None."
    rows={rows.map(row => <tr key={row.contract}>
      <td className={sideTone(row.side)} title={[row.name, row.side === 'short' ? 'Short' : 'Long'].filter(Boolean).join(' · ')}>{row.contract}{row.held ? '' : ' (closed)'}</td>
      <Cell value={signedMoney(row.pnl)} valueTone={tone(row.pnl)} />
      <Cell value={bps(row.bps)} valueTone={tone(row.bps)} />
      <Cell value={signedPct(row.changePct)} valueTone={tone(row.changePct)} />
      <Cell value={isNum(row.weightPct) ? pct(row.weightPct, 1) : '—'} valueTone={tone(row.weightPct)} />
    </tr>)} />;
}

function PnlCard({ pnl }) {
  const lines = [
    ['Position P&L', pnl.positionPnl, "Yesterday's book carried through today, against IBKR's official prior closes"],
    ['Trading P&L', pnl.tradingPnl, "Today's fills against the current mark"],
    ['Longs', pnl.longPnl], ['Shorts', pnl.shortPnl],
    ['Attributed', pnl.attributed, isNum(pnl.coveragePct) ? `Covers ${pnl.coveragePct.toFixed(0)}% of gross exposure` : undefined],
    ['Other', pnl.unattributed, "IBKR's account figure less the attributed positions: options, fees, interest, FX and mark timing"],
    ['IBKR account', pnl.account?.daily], ['IBKR realized', pnl.account?.realized], ['IBKR unrealized', pnl.account?.unrealized],
  ];
  const split = pnl.alphaBeta || {};
  return <Card title="P&L" note={pnl.attributionBasis === 'held-all-day' ? 'Marked as held all day' : null}>
    <Cells columns={2} label="P&L breakdown" labelWidth="9.5em">
      {lines.map(([label, value, title]) => <Figure key={label} label={label} value={signedMoney(value)} valueTone={tone(value)} title={title} />)}
      {split.status === 'available'
        ? [<Figure key="beta" label="Beta exposure" value={pct(split.betaExposurePct)} valueTone={tone(split.betaExposurePct)}
            title={`${money(split.betaExposure)}: each holding's value times its measured beta to ${split.benchmark}, as a share of NLV; betas cover ${split.coveragePct.toFixed(0)}% of gross`} />,
          <Figure key="market" label="From market" value={signedMoney(split.marketPnl)} valueTone={tone(split.marketPnl)}
            title={`Beta exposure times ${split.benchmark}'s move of ${signedPct(split.benchmarkChangePct)}`} />,
          <Figure key="selection" label="From selection" value={signedMoney(split.selectionPnl)} valueTone={tone(split.selectionPnl)}
            title="Attributed P&L of the measured holdings less the market's share" />]
        : <Figure label="Market vs selection" value={NA}
            title={isNum(split.coveragePct) ? `Measured betas cover ${split.coveragePct.toFixed(0)}% of gross; ${split.minCoveragePct}% is needed` : 'Betas or the market move were unavailable'} />}
      {pnl.byAssetClass.length > 1 && pnl.byAssetClass.map(row =>
        <Figure key={`class-${row.label}`} label={row.label} value={signedMoney(row.pnl)} valueTone={tone(row.pnl)} />)}
    </Cells>
  </Card>;
}

function TradingCard({ trading, nlv }) {
  if (trading.status === 'unavailable') return <Card title="Trading" wide><p className="analyst-daily__empty">Today’s fills unavailable.</p></Card>;
  const summary = trading.rows.length
    ? `${trading.symbolCount} securities · ${trading.fillCount} fills · ${money(trading.grossNotional)} traded${isNum(trading.grossNotional) && nlv ? ` (${pct(trading.grossNotional / nlv * 100, 1)} of NLV)` : ''}${isNum(trading.commission) ? ` · ${money(trading.commission)} commission` : ''}`
    : null;
  return <Card title="Trading" note={summary} wide>
    <Table label="Today's trades" empty="No fills today."
      columns={['Security', 'Action', 'Net', 'NLV', 'Avg buy', 'Avg sell', 'Mark', 'Since fill', 'Realized', 'Weight now', 'Last fill']}
      rows={trading.rows.map(row => <tr key={row.contract}>
        <td>{row.contract}</td><Cell value={row.action} valueTone={tone(row.netNotional)} />
        <Cell value={signedMoney(row.netNotional)} valueTone={tone(row.netNotional)} />
        <Cell value={signedPct(row.netPctNlv)} valueTone={tone(row.netPctNlv)} title="Net bought (+) or sold (−), as a share of NLV" />
        <Cell value={isNum(row.avgBuy) ? price(row.avgBuy) : '—'} /><Cell value={isNum(row.avgSell) ? price(row.avgSell) : '—'} />
        <Cell value={isNum(row.mark) ? price(row.mark) : '—'} />
        <Cell value={isNum(row.tradingPnl) ? signedMoney(row.tradingPnl) : '—'} valueTone={tone(row.tradingPnl)} title="Today's fills against the current mark" />
        <Cell value={isNum(row.realized) && Math.round(row.realized) !== 0 ? signedMoney(row.realized) : '—'} valueTone={tone(row.realized)}
          title="IBKR realized P&L against average cost" />
        <Cell value={isNum(row.weightPct) ? pct(row.weightPct, 1) : '—'} valueTone={tone(row.weightPct)} />
        <Cell value={stamp(row.lastAt) || '—'} />
      </tr>)} />
  </Card>;
}

function ExposureCard({ exposure }) {
  const baseline = exposure.comparison.status === 'available'
    ? `vs ${day(exposure.comparison.baselineSessionDate)} close${exposure.comparison.rebuilt ? ' (rebuilt)' : ''}` : 'No previous-close capture';
  return <Card title="Exposure" note={`${exposure.positionCount} positions · ${exposure.longCount} long · ${exposure.shortCount} short · ${baseline}`}>
    <Table label="Exposure" columns={['', 'Value', 'Current', 'Δ', 'Previous']} empty="Unavailable."
      rows={exposure.rows.map(row => <tr key={row.key}>
        <td>{row.label}</td><Cell value={money(row.value)} valueTone={tone(row.value)} /><Cell value={pct(row.pct)} valueTone={tone(row.pct)} />
        <Cell value={isNum(row.deltaBps) ? bps(row.deltaBps) : '—'} valueTone={tone(row.deltaBps)} title="Change since the previous close, in basis points of NLV" />
        <Cell value={isNum(row.previousPct) ? pct(row.previousPct) : '—'} valueTone={tone(row.previousPct)} />
      </tr>)} />
    {exposure.assetClasses.length > 0 && <Table label="Asset classes" columns={['Asset class', 'Long', 'Short', 'Net']} empty=""
      rows={exposure.assetClasses.map(row => <tr key={row.label}>
        <td>{row.label}</td><Cell value={pct(row.longPct)} valueTone={tone(row.longPct)} /><Cell value={pct(row.shortPct)} valueTone={tone(row.shortPct)} />
        <Cell value={pct(row.netPct)} valueTone={tone(row.netPct)} />
      </tr>)} />}
  </Card>;
}

function MarketCard({ market }) {
  const cells = market.rows.map(row => [MARKET_LABEL[row.symbol] || row.label, row.kind === 'yield' ? `${row.price.toFixed(2)}%` : level(row.price),
    row.kind === 'yield' ? bps(row.change * 100) : signedPct(row.changePct), row.change, `${row.source || ''} ${stamp(row.observedAt) || ''}`.trim()]);
  if (market.vix) cells.push(['VIX', level(market.vix.level), signedPct(market.vix.changePct), market.vix.changePct, `${market.vix.source || ''} ${day(market.vix.asOf)} close`.trim()]);
  const leaders = market.sectors.slice(0, 3);
  const laggards = market.sectors.slice(-3).reverse().filter(row => !leaders.includes(row));
  const sector = row => <span key={row.symbol} className="analyst-daily__sector">{row.symbol} <span className={tone(row.changePct).trim()}>{signedPct(row.changePct)}</span></span>;
  return <Card title="Market" wide>
    {cells.length ? <Cells columns={4} label="Market moves" labelWidth="5.5em">{cells.map(([label, value, change, direction, title]) =>
      <div key={label} className="analyst-daily__figure" title={title}><dt>{label}</dt>
        <dd>{value} <span className={tone(direction).trim()}>{change}</span></dd></div>)}</Cells>
      : <p className="analyst-daily__empty">No same-session market prices.</p>}
    {market.sectors.length > 0 && <p className="analyst-daily__sectors"><span>Sectors</span>{leaders.map(sector)}
      {laggards.length > 0 && <><span className="analyst-daily__divider">…</span>{laggards.map(sector)}</>}</p>}
  </Card>;
}

function PredictionCard({ prediction }) {
  if (prediction.status !== 'ready') return <Card title="Prediction markets" wide><p className="analyst-daily__empty">Kalshi account unavailable.</p></Card>;
  const today = prediction.today;
  const events = prediction.ibkrEventContracts;
  return <Card title="Prediction markets" note={stamp(prediction.asOf) ? `Kalshi as of ${stamp(prediction.asOf)}` : null} wide>
    <Cells columns={4} label="Kalshi account" labelWidth="7.5em">
      <Figure label="Account" value={money(prediction.account)} />
      <Figure label="Cash" value={money(prediction.cash)} />
      <Figure label="At risk" value={`${money(prediction.atRisk)} · ${pct(prediction.atRiskPct, 1)}`} title="Cost of open lines, and its share of the account" />
      <Figure label="Value now" value={money(prediction.value)} title={prediction.unvalued ? `${prediction.unvalued} position(s) with no bid left out` : undefined} />
      <Figure label="Open P&L" value={signedMoney(prediction.pnl)} valueTone={tone(prediction.pnl)} />
      <Figure label="Max payout" value={money(prediction.maxPayout)} />
      {today && <Figure label="Bought today" value={money(today.fills.bought)} title={`${today.fills.count} fills since ${stamp(today.since)}`} />}
      {today && <Figure label="Sold today" value={money(today.fills.sold)} />}
      {today && <Figure label="Settled today" value={today.settlements.count ? signedMoney(today.settlements.pnl) : '—'}
        valueTone={today.settlements.count ? tone(today.settlements.pnl) : ''} title={`${today.settlements.count} lines settled, after fees`} />}
      {events && <Figure label="IBKR events" value={`${events.count} · ${money(events.value)}`} title="Event contracts held at IBKR: count and value" />}
    </Cells>
    <Table label="Kalshi positions" empty="No open lines." columns={['Market', 'Side', 'Lines', 'Cost', 'Acct', 'Value', 'P&L', 'Max pay', 'State']}
      rows={prediction.positions.map(row => <tr key={`${row.market}-${row.side}`} className={row.tone === 'red' ? 'is-flagged' : undefined}>
        <td>{[row.section, row.market].filter(Boolean).join(' · ')}</td>
        <Cell value={row.side === 'YES' ? 'Yes' : 'No'} valueTone={row.side === 'YES' ? ' is-positive' : ' is-negative'} />
        <Cell value={row.lines} /><Cell value={money(row.cost)} /><Cell value={pct(row.pct, 1)} /><Cell value={money(row.value)} />
        <Cell value={signedMoney(row.pnl)} valueTone={tone(row.pnl)} /><Cell value={money(row.maxPayout)} />
        <Cell value={KALSHI_STATE[row.state] || row.state || '—'} valueTone={row.tone === 'red' ? ' is-negative' : row.tone === 'yellow' ? ' is-caution' : ''} />
      </tr>)} />
    {today?.fills.rows.length > 0 && <Table label="Kalshi fills today" empty="" columns={['Today’s fills', 'Side', 'Action', 'Contracts', 'Avg ¢', 'Dollars', 'Last fill']}
      rows={today.fills.rows.map(row => <tr key={`${row.market}-${row.side}-${row.action}`}>
        <td>{row.market}</td><Cell value={row.side === 'YES' ? 'Yes' : 'No'} valueTone={row.side === 'YES' ? ' is-positive' : ' is-negative'} />
        <Cell value={row.action === 'buy' ? 'Buy' : 'Sell'} valueTone={row.action === 'buy' ? ' is-positive' : ' is-negative'} />
        <Cell value={Math.round(row.contracts).toLocaleString('en-US')} /><Cell value={(row.avgPrice * 100).toFixed(1)} />
        <Cell value={money(row.dollars)} /><Cell value={stamp(row.lastAt) || '—'} />
      </tr>)} />}
    {today?.settlements.rows.length > 0 && <Table label="Kalshi settlements today" empty="" columns={['Settled today', 'Result', 'Cost', 'Paid', 'P&L']}
      rows={today.settlements.rows.map(row => <tr key={row.ticker}>
        <td title={row.ticker}>{row.market}</td><Cell value={row.result === 'YES' ? 'Yes' : row.result === 'NO' ? 'No' : '—'} valueTone={row.result === 'YES' ? ' is-positive' : row.result === 'NO' ? ' is-negative' : ''} />
        <Cell value={money(row.cost)} /><Cell value={money(row.revenue)} /><Cell value={signedMoney(row.pnl)} valueTone={tone(row.pnl)} />
      </tr>)} />}
    {prediction.flags.map(flag => <p key={flag.text} className={`analyst-daily__flag${flag.tone === 'red' ? ' is-negative' : ' is-caution'}`}>{flag.text}</p>)}
  </Card>;
}

export default function AnalystDailyReview({ sheet, messageId }) {
  const { headline, pnl, exposure, liquidity } = sheet;
  const benchmark = headline.benchmark;
  return <article data-message-id={messageId} className="analyst-daily" aria-label="Daily Review">
    <header className="analyst-daily__header">
      <h2>Daily Review · {day(sheet.marketDate)}</h2>
      <p>{[SESSION[sheet.session], stamp(sheet.asOf) && `as of ${stamp(sheet.asOf)}`].filter(Boolean).join(' · ')}</p>
    </header>
    <Cells columns={6} label="Headline" labelWidth="5em" className="is-headline">
      <Figure label="Day P&L" value={signedMoney(headline.dayPnl)} valueTone={tone(headline.dayPnl)} title={BASIS[headline.basis]} />
      <Figure label="Return" value={signedPct(headline.dayPnlPct)} valueTone={tone(headline.dayPnlPct)} title={PCT_BASIS[headline.pctBasis]} />
      <Figure label={benchmark ? benchmark.symbol : 'Market'} value={signedPct(benchmark?.changePct)} valueTone={tone(benchmark?.changePct)}
        title={benchmark && stamp(benchmark.observedAt) ? `Observed ${stamp(benchmark.observedAt)}` : undefined} />
      <Figure label={benchmark ? `vs ${benchmark.symbol}` : 'vs market'} value={isNum(headline.vsBenchmarkPct) ? `${signedPct(headline.vsBenchmarkPct)}` : NA} valueTone={tone(headline.vsBenchmarkPct)}
        title="Return less the market's move, in percentage points" />
      <Figure label="NLV" value={money(headline.nlv)} />
      <Figure label="NLV Δ" value={signedMoney(headline.nlvChange)} valueTone={tone(headline.nlvChange)}
        title={stamp(headline.previousNlvAsOf) ? `NLV change since the capture at ${stamp(headline.previousNlvAsOf)}; includes deposits and withdrawals` : 'NLV change: no previous-close capture'} />
    </Cells>
    {sheet.notes.length > 0 && <ul className="analyst-daily__notes" aria-label="Data gaps">{sheet.notes.map(note => <li key={note}>{note}</li>)}</ul>}
    <div className="analyst-daily__grid">
      <PnlCard pnl={pnl} />
      <Card title="Contributors and detractors" note={pnl.unpriced.length ? `${pnl.unpriced.length} not attributed` : null}>
        <Movers label="Contributors" rows={pnl.contributors} />
        <Movers label="Detractors" rows={pnl.detractors} />
      </Card>
      <TradingCard trading={sheet.trading} nlv={headline.nlv} />
      <ExposureCard exposure={exposure} />
      <Card title="Largest positions and liquidity">
        <Table label="Largest positions" columns={['Position', 'Value', 'NLV']} empty="None."
          rows={exposure.concentrations.slice(0, 8).map(row => <tr key={row.symbol}>
            <td className={sideTone(row.side)} title={row.side === 'short' ? 'Short' : 'Long'}>{row.symbol}</td>
            <Cell value={money(row.value)} valueTone={tone(row.value)} /><Cell value={pct(row.pct, 1)} valueTone={tone(row.pct)} />
          </tr>)} />
        <Cells columns={2} label="Liquidity" labelWidth="9.5em">
          <Figure label="Cash" value={money(liquidity.cash)} />
          <Figure label="Buying power" value={money(liquidity.buyingPower)} />
          <Figure label="Excess liquidity" value={money(liquidity.excessLiquidity)}
            title={isNum(liquidity.excessLiquidityPct) ? `${pct(liquidity.excessLiquidityPct)} of NLV` : undefined} />
          <Figure label="Maint. margin" title="Maintenance margin requirement" value={money(liquidity.maintenanceMargin)} />
          <Figure label="Open orders" value={isNum(liquidity.openOrders) ? liquidity.openOrders : NA} />
        </Cells>
      </Card>
      <MarketCard market={sheet.market} />
      <PredictionCard prediction={sheet.prediction} />
    </div>
  </article>;
}
