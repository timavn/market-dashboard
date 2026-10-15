const unavailableSettlementBasis = (reason) => ({
  status: 'unavailable',
  instrument: null,
  method: null,
  observationAt: null,
  sourceName: null,
  sourceUrl: null,
  rulesUrl: null,
  reason,
});

export function buildSettlementIdentityViewModel(venueSelection, {
  checking = false,
  nowMs = Date.now(),
} = {}) {
  const venue = venueSelection?.venue || null;
  const venueId = String(venue?.id || venueSelection?.id || '').trim().toLowerCase();
  const recognizedVenue = venueId === 'kalshi'
    ? 'KALSHI'
    : venueId === 'forecastex' ? 'FORECASTEX' : null;
  const event = venueSelection?.contracts?.event || venue?.catalog?.event || null;
  if (checking && !venue) {
    return {
      status: 'checking',
      venueText: 'VENUE CHECKING',
      settlementText: 'SETTLEMENT CHECKING',
      eventTicker: null,
      basis: null,
      accessibleLabel: 'Prediction venue checking. Settlement basis checking.',
    };
  }

  const basis = venue?.settlementBasis || null;
  const rawProductCode = event?.seriesTicker || event?.productCode || '';
  const eventProductCode = /^KX[A-Z0-9]+-/i.exec(String(event?.ticker || event?.generationId || ''))?.[0]?.slice(0, -1) || '';
  const productCode = String(rawProductCode || eventProductCode || '').trim().toUpperCase() || null;
  const catalogExpiry = Date.parse(venue?.catalog?.expiresAt || venue?.catalog?.event?.closeTime || '');
  const currentGenerationId = String(venue?.catalog?.event?.generationId || venue?.catalog?.event?.ticker || '');
  const displayedGenerationId = String(event?.generationId || event?.ticker || '');
  const generationMatches = !currentGenerationId || !displayedGenerationId
    || currentGenerationId === displayedGenerationId;
  const catalogCurrent = venue?.catalog?.status === 'available'
    && Number.isFinite(catalogExpiry)
    && catalogExpiry >= Number(nowMs)
    && generationMatches;
  const verified = basis?.status === 'verified'
    && catalogCurrent
    && Boolean(basis.instrument && basis.method && basis.observationAt && basis.sourceName && basis.sourceUrl);
  const partial = basis?.status === 'partial'
    && basis?.instrumentScope === 'product'
    && catalogCurrent
    && Boolean(basis.instrument && basis.method && basis.observationAt && basis.sourceName && basis.sourceUrl && basis.reason);
  if (recognizedVenue && partial) {
    const eventTicker = event?.ticker || event?.generationId || null;
    return {
      status: 'partial',
      venueText: recognizedVenue,
      settlementText: 'SETTLEMENT VERIFIED',
      eventTicker,
      productCode,
      basis,
      reason: basis.reason,
      accessibleLabel: [
        `Prediction venue ${recognizedVenue}.`,
        `Settlement product ${basis.instrument}.`,
        `${basis.method}.`,
        'Exact futures contract month unavailable; any displayed reference is non-executable proxy context.',
        eventTicker ? `Event ${eventTicker}.` : null,
      ].filter(Boolean).join(' '),
    };
  }
  if (!recognizedVenue || !verified) {
    const reason = !recognizedVenue
      ? 'The selected prediction venue is unavailable.'
      : !catalogCurrent
        ? 'The selected catalog generation is missing, changed, or expired.'
        : basis?.reason || 'The selected generation has no verified authoritative settlement basis.';
    return {
      status: 'unavailable',
      venueText: recognizedVenue || 'VENUE UNAVAILABLE',
      settlementText: 'SETTLEMENT BASIS UNAVAILABLE',
      eventTicker: event?.ticker || event?.generationId || null,
      productCode,
      basis: basis || unavailableSettlementBasis(reason),
      reason,
      accessibleLabel: `${recognizedVenue ? `Prediction venue ${recognizedVenue}. ` : ''}Settlement basis unavailable. ${reason}`,
    };
  }

  const settlementText = `SETTLES ON · ${String(basis.sourceName).toUpperCase()} ${basis.instrument} · ${String(basis.method).toUpperCase()}`;
  const eventTicker = event?.ticker || event?.generationId || null;
  return {
    status: 'verified',
    venueText: recognizedVenue,
    settlementText,
    eventTicker,
    productCode,
    basis,
    reason: null,
    accessibleLabel: [
      `Prediction venue ${recognizedVenue}.`,
      `Settles on ${basis.sourceName} ${basis.instrument}.`,
      `${basis.method}.`,
      `Observation time ${basis.observationAt}.`,
      eventTicker ? `Event ${eventTicker}.` : null,
    ].filter(Boolean).join(' '),
  };
}
