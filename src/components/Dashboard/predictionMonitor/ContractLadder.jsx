import React from 'react';
import DelayedDataMarker from '../DelayedDataMarker';
import { delayedMarkerMarketContext } from '../../../utils/delayedMarkerMarketContext';
import { locateSpxLivePrice } from '../../../utils/spxClosePredictionMarket';
import { finite } from './monitorNumbers';
import { MARKET_UI } from './marketUi';
import { isSpxMonitorSectionUsable } from './monitorSectionValidation';
import { formatIndex, formatCount, formatCents } from './monitorFormatting';
import { formatCpiPercent } from './cpiForecastValues';
import { contractLineGeometry, buildLadderProximityLevels } from './contractLadderGeometry';
import { formatSpotMarker, formatSpread, formatSignedDistance } from './contractLadderPresentation';
import { formatPositionCost, formatPositionAverage, formatPositionQuantity } from './predictionPositionOverlay';
import { isVerifiedDisplayReference, isLastVerifiedContractReference, isVerifiedDelayedContractReference } from './contractReferenceValidation';
import './ContractLadder.css';

// Quote rows and position maps are accepted upstream. These leaves preserve
// the existing reference gates and never fetch, derive opposite quotes, or place orders.

export const CONTRACT_COLUMN_COUNT = 9;

export const ContractQuoteCell = ({ outcome, side, price, size, groupStart = false }) => {
  const hasPrice = finite(price);
  const hasSize = hasPrice && finite(size);
  const priceLabel = hasPrice ? formatCents(price) : '—';
  const sizeLabel = hasPrice ? (hasSize ? `× ${formatCount(size)}` : 'SIZE —') : 'NO QUOTE';
  const accessibilityLabel = hasPrice
    ? `${outcome} ${side}: ${priceLabel}${hasSize ? `, displayed size ${formatCount(size)} contracts` : ', displayed size unavailable'}`
    : `${outcome} ${side}: no live quote`;

  return (
    <td
      className={`pm-spx-quote-cell${groupStart ? ' pm-spx-quote-group-start' : ''}${hasPrice ? '' : ' is-empty'}`}
      aria-label={accessibilityLabel}
    >
      <span className="pm-spx-quote-price">{priceLabel}</span>
      <span className="pm-spx-quote-size">{sizeLabel}</span>
    </td>
  );
};

export const LiveSpotMarkerRow = ({ spot, columnCount, marketUi }) => {
  const markerLabel = formatSpotMarker(spot);
  const markerPrice = formatIndex(spot?.value);
  const markerDataStatus = spot?.status === 'historical'
    || ['last_close', 'historical'].includes(String(spot?.availability || '').toLowerCase())
    ? 'historical'
    : spot?.status === 'last_verified'
      || ['last_verified', 'delayed'].includes(String(spot?.availability || '').toLowerCase())
      ? 'delayed'
      : 'live';
  const markerPriceStart = markerLabel.lastIndexOf(markerPrice);
  const markerPrefix = markerPriceStart >= 0 ? markerLabel.slice(0, markerPriceStart) : markerLabel;
  const markerSuffix = markerPriceStart >= 0
    ? markerLabel.slice(markerPriceStart + markerPrice.length)
    : '';
  const markerContext = markerPriceStart >= 0
    ? [markerPrefix.trim(), markerSuffix.trim()].filter(Boolean).join(' ')
    : markerLabel;
  return (
    <tr
      className={`pm-spx-live-marker-row${['last_verified', 'delayed'].includes(spot?.availability) ? ' is-last-verified' : ''}`}
      aria-label={markerLabel}
    >
      <td colSpan={columnCount}>
        <div className="pm-spx-live-marker-line" data-testid="spx-live-marker-line">
          <span className="pm-spx-live-marker-price-track" data-testid="spx-live-marker-price-track">
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
            {markerPriceStart >= 0 && (
              <b className="pm-spx-live-marker-price">
                {markerPrice}
                <DelayedDataMarker
                  status={markerDataStatus}
                  title={markerLabel}
                  updatedAt={spot?.lastVerifiedAt || spot?.asOf || spot?.timestamp || spot?.observedAt}
                  {...delayedMarkerMarketContext(spot, marketUi)}
                />
              </b>
            )}
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-middle-track">
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-context-track" data-testid="spx-live-marker-context-track">
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
            {markerPriceStart >= 0 && (
              <span className="pm-spx-live-marker-label" data-testid="spx-live-marker-label">
                <span className="pm-spx-live-marker-context">{markerContext}</span>
              </span>
            )}
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
          </span>
        </div>
      </td>
    </tr>
  );
};

export const CpiLadderReferenceRow = ({ reference, columnCount }) => {
  const parsedAsOf = Date.parse(reference?.asOf || '');
  const pullDate = Number.isFinite(parsedAsOf)
    ? new Intl.DateTimeFormat('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: '2-digit',
        timeZone: 'America/Los_Angeles',
      }).format(new Date(parsedAsOf))
    : 'DATE UNAVAILABLE';
  const label = reference.label || 'HEDGEYE BASE';
  return (
    <tr
      className="pm-cpi-ladder-reference-row"
      aria-label={`${label} ${pullDate} ${formatCpiPercent(reference.value)}`}
      data-testid="cpi-ladder-reference-row"
    >
      <td colSpan={columnCount}>
        <div className="pm-spx-live-marker-line">
          <span className="pm-spx-live-marker-price-track">
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
            <b className="pm-spx-live-marker-price">
              {formatCpiPercent(reference.value)}
            </b>
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-middle-track">
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-context-track">
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
            <span className="pm-spx-live-marker-label">
              <span className="pm-spx-live-marker-context">{label} · {pullDate}</span>
            </span>
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
          </span>
        </div>
      </td>
    </tr>
  );
};

export const LiveFesPositionSummary = ({ position }) => {
  const cost = formatPositionCost(position.cost);
  const average = formatPositionAverage(position.averageCost);
  const quantity = formatPositionQuantity(position.quantity);
  return (
    <span
      className="pm-spx-position-summary"
      aria-label={`Live IBKR position: ${position.side}, cost ${cost}, average price ${average}, quantity ${quantity}`}
    >
      <span className={`pm-spx-position-side is-${position.side.toLowerCase()}`}>{position.side}</span>
      <span aria-hidden="true"> - {cost} ({average} × {quantity})</span>
    </span>
  );
};

export const ContractLadder = ({
  snapshot,
  analyses,
  nowMs,
  marketUi = MARKET_UI.sp500,
  venueSelection = null,
  positionMap = null,
}) => {
  const spot = snapshot?.spot;
  const eventTicker = snapshot?.contracts?.event?.ticker || null;
  const referenceSymbol = snapshot?.contractReferenceLabel || marketUi.symbol;
  const contractResolverSymbol = snapshot?.contracts?.event?.resolverSymbol || referenceSymbol;
  const strictFesReference = marketUi.fixedContract?.productCode === 'FES'
    && venueSelection?.id === 'forecastex';
  const spotAvailable = finite(spot?.value) && (strictFesReference
    ? (
        isVerifiedDisplayReference(spot, nowMs)
        || isLastVerifiedContractReference(spot, eventTicker, nowMs)
        || isVerifiedDelayedContractReference(spot, contractResolverSymbol, nowMs)
      )
    : marketUi.simplified === true
      ? isVerifiedDisplayReference(spot, nowMs)
      : isSpxMonitorSectionUsable(spot, nowMs));
  const ladderReference = snapshot?.ladderReference;
  const ladderReferenceAvailable = marketUi.fixedContract?.productCode === 'KXCPIYOY'
    && ladderReference?.status === 'available'
    && ladderReference?.kind === 'hedgeye_base'
    && ladderReference?.executable === false
    && ladderReference?.reportMonth === snapshot?.contracts?.event?.reportMonth
    && finite(ladderReference?.value)
    && Number.isFinite(Date.parse(ladderReference?.expiresAt || ''))
    && Date.parse(ladderReference.expiresAt) > nowMs
    && Boolean(String(ladderReference?.source || '').trim());
  const activeReference = spotAvailable ? spot : ladderReferenceAvailable ? ladderReference : null;
  const referenceAvailable = Boolean(activeReference);
  const usesSharedAboveComparator = marketUi.fixedContract?.productCode === 'FES'
    && analyses.every(({ line }) => !line?.comparator || line.comparator === '>');
  const lines = analyses.map(({ line }) => line);
  const placementLines = lines.map((line) => ({
    ...line,
    threshold: contractLineGeometry(line)?.anchor ?? line.threshold,
  }));
  const placement = referenceAvailable ? locateSpxLivePrice(placementLines, activeReference.value) : null;
  const proximityLevels = referenceAvailable
    ? buildLadderProximityLevels(lines, activeReference.value)
    : new Map();
  const contractRowCount = Math.max(1, analyses.length);
  const ladderStyle = {
    '--pm-spx-ladder-row-share': `${100 / contractRowCount}%`,
  };

  return (
    <section
      className="pm-spx-ladder-panel"
      aria-label={`${marketUi.fullLabel} prediction-market contract ladder`}
      data-market-symbol={marketUi.symbol}
      data-contract-row-count={analyses.length}
      data-fit-mode="no-scroll"
      style={ladderStyle}
    >
      <table className="pm-spx-ladder-table">
        <caption className="pm-spx-visually-hidden">
          {snapshot?.cardView ? 'Selected display' : 'All active'} {venueSelection?.label || 'prediction-market'} {marketUi.fullLabel} lines, sorted by strike
        </caption>
        <colgroup>
          <col className="pm-spx-ladder-col-line" />
          <col className="pm-spx-ladder-col-quote" span="4" />
          <col className="pm-spx-ladder-col-volume" />
          <col className="pm-spx-ladder-col-open-interest" />
          <col className="pm-spx-ladder-col-spread" />
          <col className="pm-spx-ladder-col-distance" />
        </colgroup>
        <thead>
          <tr className="pm-spx-ladder-group-row">
            <th rowSpan="2" scope="col">
              <span>{usesSharedAboveComparator ? `${contractResolverSymbol} SETTLES ABOVE` : 'LINE'}</span>
            </th>
            <th className="pm-spx-quote-group-heading is-yes" colSpan="2" scope="colgroup" title="Native Yes quotes and displayed sizes from the selected venue.">YES</th>
            <th className="pm-spx-quote-group-heading is-no pm-spx-quote-group-start" colSpan="2" scope="colgroup" title="Native No quotes and displayed sizes from the selected venue.">NO</th>
            <th rowSpan="2" scope="col" title="Contracts traded during the published rolling 24-hour period. Volume may include contracts later closed.">24H VOL</th>
            <th rowSpan="2" scope="col" title="Currently open contracts on this exact line. OI is a contract count, not dollars or an entry-price distribution.">LINE OI</th>
            <th rowSpan="2" scope="col">Y / N SPREAD</th>
            <th rowSpan="2" scope="col">Δ {ladderReferenceAvailable ? 'HYE BASE' : referenceSymbol}</th>
          </tr>
          <tr className="pm-spx-ladder-quote-row">
            <th scope="col" title="Native venue Yes bid; displayed size appears below the price when published.">BID</th>
            <th scope="col" title="Native venue Yes ask; displayed size appears below the price when published.">ASK</th>
            <th className="pm-spx-quote-group-start" scope="col" title="Native venue No bid; displayed size appears below the price when published.">BID</th>
            <th scope="col" title="Native venue No ask; displayed size appears below the price when published.">ASK</th>
          </tr>
        </thead>
        <tbody>
          {placement?.afterIndex === -1 && (spotAvailable
            ? <LiveSpotMarkerRow spot={spot} columnCount={CONTRACT_COLUMN_COUNT} marketUi={marketUi} />
            : <CpiLadderReferenceRow reference={ladderReference} columnCount={CONTRACT_COLUMN_COUNT} />)}
          {analyses.map(({ line }, index) => {
            const positionKey = String(line.contractId || line.ticker || '').trim().toUpperCase();
            const linePositions = positionMap?.get(positionKey) || [];
            const lineLabel = line.comparator === 'inclusive_range'
              ? `${formatIndex(line.lowerBound, marketUi.precision ?? 0)}–${formatIndex(line.upperBound, marketUi.precision ?? 0)}`
              : formatIndex(line.threshold, marketUi.precision ?? 0);
            const lineDescription = line.comparator === 'inclusive_range'
              ? `Inclusive range ${lineLabel}`
              : `${line.comparator === '<' ? 'Settles below' : 'Settles above'} ${lineLabel}`;
            const proximityLevel = proximityLevels.get(index) || null;
            const rowClasses = [
              line.status === 'incomplete' || line.status === 'unavailable' ? 'is-incomplete' : null,
              proximityLevel ? `is-spot-proximity-${proximityLevel}` : null,
            ].filter(Boolean).join(' ') || undefined;
            return (
              <React.Fragment key={line.ticker}>
                <tr className={rowClasses} data-spot-proximity={proximityLevel || undefined}>
                  <td
                    className={`pm-spx-line-cell${linePositions.length ? ' has-position' : ''}`}
                    data-comparator={line.comparator || '>'}
                  >
                    <div className="pm-spx-line-content">
                      <strong title={lineDescription}>{lineLabel}</strong>
                      {linePositions.map((position) => (
                        <LiveFesPositionSummary key={position.side} position={position} />
                      ))}
                    </div>
                  </td>
                  <ContractQuoteCell outcome="Yes" side="bid" price={line.yesBid} size={line.yesBidSize} />
                  <ContractQuoteCell outcome="Yes" side="ask" price={line.yesAsk} size={line.yesAskSize} />
                  <ContractQuoteCell outcome="No" side="bid" price={line.noBid} size={line.noBidSize} groupStart />
                  <ContractQuoteCell outcome="No" side="ask" price={line.noAsk} size={line.noAskSize} />
                  <td>{formatCount(line.volume24h)}</td>
                  <td>{formatCount(line.openInterest)}</td>
                  <td>{formatSpread(line.yesBid, line.yesAsk)} / {formatSpread(line.noBid, line.noAsk)}</td>
                  <td className={referenceAvailable && Number(contractLineGeometry(line)?.anchor) < Number(activeReference.value) ? 'is-negative' : referenceAvailable ? 'is-positive' : ''}>
                    {referenceAvailable ? formatSignedDistance(
                      contractLineGeometry(line)?.range
                        ? Number(activeReference.value) < contractLineGeometry(line).lower
                          ? contractLineGeometry(line).lower
                          : Number(activeReference.value) > contractLineGeometry(line).upper
                            ? contractLineGeometry(line).upper
                            : activeReference.value
                        : contractLineGeometry(line)?.anchor,
                      activeReference.value,
                    ) : '—'}
                  </td>
                </tr>
                {placement?.afterIndex === index && (spotAvailable
                  ? <LiveSpotMarkerRow spot={spot} columnCount={CONTRACT_COLUMN_COUNT} marketUi={marketUi} />
                  : <CpiLadderReferenceRow reference={ladderReference} columnCount={CONTRACT_COLUMN_COUNT} />)}
              </React.Fragment>
            );
          })}
          {analyses.length === 0 && (
            <tr className="pm-spx-ladder-empty"><td colSpan={CONTRACT_COLUMN_COUNT}>
              {snapshot?.contracts?.reason || `NO VERIFIED ACTIVE ${marketUi.label.toUpperCase()} LINES`}
            </td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
};

export default ContractLadder;
