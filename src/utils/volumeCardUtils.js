import {
  calculateExchangeVolumeMetrics,
  hasUnverifiedVolumeFlags,
  isVerifiedExchangeVolumeResponse,
} from './exchangeVolume.cjs';
import { isVerifiedExUsVolumeResponse } from './exUsVolume.cjs';

// Compatibility export; the API and UI helpers share one volume methodology.
export const calculateVolumeMetrics = calculateExchangeVolumeMetrics;

// Each market keeps its own verification state. A failed U.S. source must not
// erase a verified ex-U.S. response (or vice versa); wrapper cache flags do.
export function getVerifiedVolumeMarkets(response, now = new Date()) {
  if (!response || hasUnverifiedVolumeFlags(response)) return { us: null, exUs: null };
  return {
    us: isVerifiedExchangeVolumeResponse(response, now) ? response : null,
    exUs: isVerifiedExUsVolumeResponse(response.exUs, now) ? response.exUs : null,
  };
}

/**
 * Returns formatted header date (e.g. "3/9") for the Volume card from API response.
 * Uses asOf (last closed trading day) or first date in totalMarket/totalExchange.
 */
export function getVolumeCardHeaderDate(response) {
  const asOfDate =
    response?.asOf ||
    (response?.totalMarket?.[0]?.date ?? response?.totalExchange?.[0]?.date);
  if (!asOfDate) return '';
  // Parse YYYY-MM-DD as calendar date to avoid timezone shifting (e.g. 2026-03-09 -> 3/9)
  const parts = String(asOfDate).split('-');
  if (parts.length < 3) return '';
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (Number.isNaN(month) || Number.isNaN(day)) return '';
  return `${month}/${day}`;
}
