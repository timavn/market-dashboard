import React from 'react';
import DelayedDataMarker from '../DelayedDataMarker';
import { delayedMarkerMarketContext } from '../../../utils/delayedMarkerMarketContext';
import { isVerifiedDisplayReference } from './contractReferenceValidation';
import {
  isRetainableSpxHeaderReference,
  isVerifiedHistoricalCashHeaderQuote,
  isVerifiedLiveCashHeaderQuote,
  normalizeGoldHeaderMarketReference,
  resolveDayChangePercent,
} from './headerMarketReferences';
import { formatAsOf, formatIndex } from './monitorFormatting';
import { finite } from './monitorNumbers';

const formatDayChangePercent = (value) => {
  if (!finite(value)) return '—';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
};

const humanizeSource = (value) => String(value || '—')
  .replaceAll('_', ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

const compactGoldReferenceSource = (source) => {
  const token = String(source || '').trim().toLowerCase();
  if (!token) return 'SOURCE —';
  if (token.startsWith('pyth_lazer')) return 'PYTH LAZER';
  if (token.startsWith('pyth')) return 'PYTH';
  if (token === 'ibkr') return 'IBKR';
  if (token.startsWith('ibkr_historical')) return 'IBKR HISTORY';
  if (token.startsWith('ibkr')) return 'IBKR';
  return humanizeSource(token);
};

const SpxHeaderMarketMeasure = ({
  kind,
  symbol,
  value,
  changePercent = null,
  asOf = null,
  status = 'unavailable',
  reason = null,
  precision = 2,
  primary = false,
  referenceRole = 'proxy',
  testIdPrefix = 'spx',
  details = null,
  markerMarket = {},
}) => {
  const historical = status === 'historical';
  const delayed = status === 'delayed';
  const available = ['live', 'historical', 'delayed'].includes(status) && finite(value);
  const priceTone = !available
    ? 'unavailable'
    : finite(changePercent)
      ? Number(changePercent) > 0 ? 'positive' : Number(changePercent) < 0 ? 'negative' : 'neutral'
      : 'neutral';
  const changeTone = available && finite(changePercent)
    ? priceTone
    : 'unavailable';
  const directionPeriod = historical ? 'versus the prior close' : 'today';
  const direction = !finite(changePercent)
    ? 'daily change unavailable'
    : Number(changePercent) > 0
      ? `up ${Math.abs(Number(changePercent)).toFixed(2)} percent ${directionPeriod}`
      : Number(changePercent) < 0
        ? `down ${Math.abs(Number(changePercent)).toFixed(2)} percent ${directionPeriod}`
        : `unchanged ${directionPeriod}`;
  const directReference = ['primary', 'direct'].includes(referenceRole);
  const referenceRoleLabel = referenceRole === 'direct' ? 'DIRECT' : referenceRole === 'primary' ? 'PRIMARY' : 'PROXY';
  const referenceRoleDescription = referenceRole === 'primary'
    ? 'Primary instrument used by this contract'
    : directReference
      ? 'Direct instrument used by this contract settlement basis'
      : 'Related market proxy; not the contract resolver';
  const statusText = status === 'loading'
    ? `Checking ${referenceRoleDescription.toLowerCase()} ${symbol}`
    : available
      ? `${referenceRoleDescription}. ${delayed ? 'Delayed, last verified ' : ''}${kind} ${symbol}, ${formatIndex(value, precision)}, ${direction}${asOf ? `, as of ${asOf}` : ''}`
      : `${referenceRoleDescription}. ${kind} ${symbol} unavailable${reason ? `. ${reason}` : ''}`;
  const parenthesizedChange = available && finite(changePercent)
    ? `(${formatDayChangePercent(changePercent)})`
    : '(—)';

  return (
    <div
      className={`pm-spx-market-measure is-${status}${primary ? ' is-primary' : ''}`}
      data-testid={`${testIdPrefix}-header-measure-${String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      aria-label={statusText}
      title={statusText}
    >
      <span className="pm-spx-market-measure-kind">
        <span>{kind}</span>
        <b>{symbol}</b>
        <em
          className={`pm-spx-market-measure-role pm-spx-market-measure-role--${referenceRole}`}
          aria-label={referenceRoleDescription}
          title={referenceRoleDescription}
        >
          {referenceRoleLabel}
        </em>
      </span>
      <span className="pm-spx-market-measure-row">
        <span className="pm-spx-market-measure-value">
          <strong className={`${primary ? 'pm-spx-chart-price ' : ''}pm-spx-market-measure-price is-${priceTone}`}>
            {available ? formatIndex(value, precision) : '—'}
          </strong>
          <span
            className={`${primary ? 'pm-spx-day-change ' : ''}pm-spx-market-measure-change is-${changeTone}`}
            aria-label={available && finite(changePercent) ? `${symbol} ${direction}` : `${symbol} daily change unavailable`}
          >
            {parenthesizedChange}
          </span>
          <DelayedDataMarker
            status={status}
            title={delayed ? `${symbol} delayed quote` : `${symbol} historical reference`}
            updatedAt={asOf}
            {...markerMarket}
          />
        </span>
      </span>
      {details && (
        <span className="pm-spx-market-measure-details" aria-label={`${details.sourceInstrument}. ${details.statusAsOf}.`}>
          <span>{details.sourceInstrument}</span>
          <span>{details.statusAsOf}</span>
        </span>
      )}
    </div>
  );
};

const SpxHeaderMarketStrip = ({ cashSpot, spySpot, futuresReference, nowMs }) => {
  const cashLive = isVerifiedLiveCashHeaderQuote(cashSpot, nowMs);
  const cashHistorical = isVerifiedHistoricalCashHeaderQuote(cashSpot, nowMs);
  const cashDelayed = !cashLive && !cashHistorical
    && isRetainableSpxHeaderReference(cashSpot, nowMs);
  const cashAvailable = cashLive || cashHistorical || cashDelayed;
  const cashChange = cashAvailable
    ? resolveDayChangePercent(cashSpot?.value, cashSpot?.previousClose)
    : null;
  const spyLive = isVerifiedLiveCashHeaderQuote(spySpot, nowMs);
  const spyHistorical = isVerifiedHistoricalCashHeaderQuote(spySpot, nowMs);
  const spyDelayed = !spyLive && !spyHistorical
    && isRetainableSpxHeaderReference(spySpot, nowMs);
  const spyAvailable = spyLive || spyHistorical || spyDelayed;
  const spyChange = spyAvailable
    ? resolveDayChangePercent(spySpot?.value, spySpot?.previousClose)
    : null;
  const futuresSpot = futuresReference?.spot;
  const futuresLive = isVerifiedDisplayReference(futuresSpot, nowMs);
  const futuresDelayed = !futuresLive && isRetainableSpxHeaderReference(futuresSpot, nowMs);
  const futuresAvailable = futuresLive || futuresDelayed;
  const futuresHistorical = futuresSpot?.status === 'historical'
    || futuresSpot?.availability === 'historical';
  const futuresSymbol = futuresReference?.instrument?.displaySymbol
    || futuresSpot?.label
    || 'ES';
  const futuresChange = futuresAvailable
    ? resolveDayChangePercent(futuresSpot?.value, futuresSpot?.previousClose)
    : null;

  return (
    <div className="pm-spx-market-strip" role="group" aria-label="S&P 500 market measures">
      <SpxHeaderMarketMeasure
        kind={`S&P 500 INDEX${cashHistorical ? ' · LAST CLOSE' : ''}`}
        symbol="SPX"
        value={cashSpot?.value}
        changePercent={cashChange}
        asOf={cashSpot?.asOf}
        markerMarket={delayedMarkerMarketContext(cashSpot, { symbol: 'SPX' })}
        status={cashLive ? 'live' : cashHistorical ? 'historical' : cashDelayed ? 'delayed' : cashSpot?.status === 'loading' ? 'loading' : 'unavailable'}
        reason={cashSpot?.reason || 'A verified-live cash-index trade is unavailable.'}
        referenceRole="proxy"
        primary
      />
      <SpxHeaderMarketMeasure
        kind={`SPDR ETF${spyHistorical ? ' · LAST CLOSE' : ''}`}
        symbol="SPY"
        value={spySpot?.value}
        changePercent={spyChange}
        asOf={spySpot?.asOf}
        markerMarket={delayedMarkerMarketContext(spySpot, { symbol: 'SPY' })}
        status={spyLive ? 'live' : spyHistorical ? 'historical' : spyDelayed ? 'delayed' : spySpot?.status === 'loading' ? 'loading' : 'unavailable'}
        reason={spySpot?.reason}
        referenceRole="proxy"
      />
      <SpxHeaderMarketMeasure
        kind={`E-MINI FUTURE${futuresHistorical ? ' · LAST CLOSE' : ''}`}
        symbol={futuresSymbol}
        value={futuresSpot?.value}
        changePercent={futuresChange}
        asOf={futuresSpot?.asOf}
        markerMarket={delayedMarkerMarketContext(futuresSpot, { symbol: futuresSymbol })}
        status={futuresAvailable
          ? futuresDelayed ? 'delayed' : futuresHistorical ? 'historical' : 'live'
          : futuresSpot?.status === 'loading' ? 'loading' : 'unavailable'}
        reason={futuresSpot?.reason || 'The verified ES directional reference is unavailable.'}
        referenceRole="primary"
      />
    </div>
  );
};

const GoldHeaderMarketStrip = ({ references = [], nowMs }) => {
  const incoming = new Map((Array.isArray(references) ? references : [])
    .map((reference) => [reference?.key, reference]));
  const placeholders = [
    { key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy' },
    { key: 'activeComex', label: 'COMEX GOLD', symbol: 'GC', role: 'proxy' },
  ];
  const items = placeholders.map((placeholder) => normalizeGoldHeaderMarketReference(
    incoming.get(placeholder.key) || {
      ...placeholder,
      status: 'loading',
      reason: 'Verified Gold reference is loading.',
    },
    nowMs,
  ));
  return (
    <div className="pm-spx-market-strip pm-gold-market-strip" role="group" aria-label="Gold market references">
      {items.map((item, index) => (
        <SpxHeaderMarketMeasure
          key={item.key}
          kind={`${item.label}${item.status === 'historical'
            || (item.status === 'delayed' && item.retainedStatus === 'historical')
            ? ' · LAST CLOSE'
            : ''}`}
          symbol={item.symbol}
          value={item.price}
          changePercent={item.changePercent}
          asOf={item.asOf}
          markerMarket={delayedMarkerMarketContext(item, item.instrument)}
          status={item.status}
          reason={item.reason}
          precision={1}
          referenceRole={item.role}
          primary={index === 0}
          testIdPrefix="gold"
          details={{
            sourceInstrument: `${compactGoldReferenceSource(item.source)} · ${item.instrument?.displaySymbol || item.instrument?.symbol || item.symbol}`,
            statusAsOf: `${item.status.toUpperCase()} · AS OF ${item.asOf ? formatAsOf(item.asOf) : '—'}`,
          }}
        />
      ))}
      <div
        className="pm-spx-market-measure pm-gold-market-spacer"
        data-testid="gold-header-measure-spacer"
        aria-hidden="true"
      />
    </div>
  );
};

export { GoldHeaderMarketStrip, SpxHeaderMarketStrip, formatDayChangePercent, humanizeSource };
