import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { EXCLUSIONS, GAPS, GROUPS } from '../services/quadResearch/catalog.cjs';

export const QUAD_RESEARCH_UNAVAILABLE = 'Research unavailable.';
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const gapKeys = new Set(GAPS.map(({ exposureId, quad }) => `${exposureId}:${quad}`));
const benchmarks = new Map(GROUPS.flatMap(group => group.benchmarks.map(benchmark => (
  [benchmark.exposureId, { ...benchmark, peerCount: group.benchmarks.length }]
))));
const dateValid = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const quarterValid = value => /^\d{4}-?Q[1-4]$/.test(value || '');
const periodTime = value => quarterValid(value)
  ? Date.UTC(Number(value.slice(0, 4)), (Number(value.slice(-1)) - 1) * 3, 1)
  : Date.parse(value);
const supportedBootstrap = cell => [2, 4, 8].every(blockLength => {
  const result = cell.diagnostics?.bootstrap?.[blockLength];
  const interval = result?.interval;
  return result?.blockLength === blockLength && result.draws === 5000
    && Number.isInteger(result.invalidDraws) && result.invalidDraws >= 0 && result.invalidDraws <= 500
    && result.validDraws + result.invalidDraws === result.draws && !result.reason
    && Number.isInteger(interval?.lower) && Number.isInteger(interval?.upper)
    && interval.lower >= 1 && interval.upper <= cell.peerCount
    && interval.lower <= cell.rank && interval.upper >= cell.rank
    && interval.upper - interval.lower <= 2;
});
const hasUnverifiedFlags = value => Boolean(value && (
  ['mock', 'seed', 'seeded', 'synthetic', 'simulated', 'revoked', 'stale', 'cacheOnly'].some(flag => value[flag] === true)
  || value.verified === false
  || /mock|seed|synthetic|simulat|portfolio|cost.basis|cache.only/i.test(String(value.source || ''))
));

/** Research is historical, separate from quote freshness, and eligible only for canonical gaps. */
export function normalizeQuadResearch(payload) {
  if (
    payload?.schemaVersion !== 1
    || payload.source !== 'independent-quad-research'
    || payload.historicalOnly !== true
    || payload.available !== true
    || payload.verified !== true
    || hasUnverifiedFlags(payload)
    || !hashValid(payload.version)
    || !payload.methodology
    || !(quarterValid(payload.cutoff) || dateValid(payload.cutoff))
    || !dateValid(payload.generatedAt)
    || !Array.isArray(payload.cells)
    || !Array.isArray(payload.sourceHashes)
    || !payload.sourceHashes.every(hashValid)
  ) return null;

  const cells = [];
  const seen = new Set();
  for (const cell of payload.cells) {
    const key = `${cell?.exposureId}:${cell?.quad}`;
    // The fixed catalog, never a response's label, decides eligibility.
    if (!gapKeys.has(key) || EXCLUSIONS[cell.exposureId]) continue;
    if (seen.has(key) || hasUnverifiedFlags(cell)) return null;
    seen.add(key);
    const benchmark = benchmarks.get(cell.exposureId);
    if (!benchmark || !['supported', 'unavailable'].includes(cell.status)) return null;
    if (cell.status === 'supported') {
      const interval = cell.rankInterval;
      if (
        cell.classification !== 'filled'
        || !Number.isInteger(cell.rank) || cell.rank < 1 || cell.rank > benchmark.peerCount
        || cell.peerCount !== benchmark.peerCount
        || !Number.isFinite(cell.meanReturn)
        || !Number.isInteger(cell.observations) || cell.observations < 8
        || !Number.isInteger(cell.episodes) || cell.episodes < 3
        || !Array.isArray(interval) || interval.length !== 2
        || !interval.every(value => Number.isInteger(value) && value >= 1 && value <= benchmark.peerCount)
        || interval[0] > cell.rank || interval[1] < cell.rank
        || !supportedBootstrap(cell)
        || interval[0] !== Math.min(...[2, 4, 8].map(block => cell.diagnostics.bootstrap[block].interval.lower))
        || interval[1] !== Math.max(...[2, 4, 8].map(block => cell.diagnostics.bootstrap[block].interval.upper))
        || !(quarterValid(cell.sampleStart) || dateValid(cell.sampleStart))
        || !(quarterValid(cell.sampleEnd) || dateValid(cell.sampleEnd))
        || periodTime(cell.sampleStart) > periodTime(cell.sampleEnd)
        || cell.benchmark?.symbol !== benchmark.symbol
        || hasUnverifiedFlags(cell.benchmark)
        || payload.sourceHashes.length === 0
      ) return null;
    } else if (
      !['insufficient history', 'unstable', 'undefined'].includes(cell.classification)
      || cell.rank !== null
      || typeof cell.reason !== 'string' || !cell.reason.trim()
    ) return null;

    cells.push({ ...cell, benchmark });
  }
  return { ...payload, cells };
}

export function getQuadResearchCell(estimates, exposureId, quad) {
  const exclusion = EXCLUSIONS[exposureId];
  if (exclusion) return { status: 'unavailable', classification: 'undefined', reason: exclusion };
  return estimates?.cells.find(cell => cell.exposureId === exposureId && cell.quad === quad)
    || { status: 'unavailable', reason: QUAD_RESEARCH_UNAVAILABLE };
}

export default function useQuadResearch({ active = true } = {}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState({ status: 'loading', estimates: null });
  useEffect(() => {
    const controller = new AbortController();
    if (!active) {
      setState({ status: 'inactive', estimates: null });
      return () => controller.abort();
    }
    setState({ status: 'loading', estimates: null });
    const load = async () => {
      try {
        const response = await axios.get(
          `${process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'}/api/research/quad-ranks`,
          // This dated research request may wait behind the dashboard's quote
          // workload; it never blocks or extends executable quote validity.
          { signal: controller.signal, timeout: 40000 },
        );
        if (controller.signal.aborted) return;
        const estimates = normalizeQuadResearch(response.data);
        setState({ status: estimates ? 'available' : 'unavailable', estimates });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'unavailable', estimates: null });
      }
    };
    load();
    return () => controller.abort();
  }, [active, reloadKey]);
  const retry = useCallback(() => setReloadKey(value => value + 1), []);
  return { ...state, retry };
}
