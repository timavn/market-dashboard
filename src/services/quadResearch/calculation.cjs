'use strict';

// Retrospective research only. These ranks never establish quote availability,
// replicate a publisher's selected-list positions, or imply executable prices.
const METHODOLOGY = Object.freeze({
  id: 'independent-quad-category-rank-v1',
  version: '1.0.0',
  seed: 0x51554144,
  minimumOverallQuarters: 32,
  minimumQuadQuarters: 8,
  minimumEpisodes: 3,
  bootstrap: Object.freeze({
    draws: 5000,
    blockLengths: Object.freeze([2, 4, 8]),
    lowerQuantile: 0.1,
    upperQuantile: 0.9,
    maximumInvalidFraction: 0.1,
    maximumRankIntervalWidth: 2,
  }),
  sensitivity: Object.freeze({
    boundaryPercentagePoints: 0.1,
    minimumQuadQuarters: 6,
    minimumEpisodes: 2,
    minimumLeaveEpisodeQuarters: 4,
    maximumRankShift: 2,
  }),
});

const QUADS = [1, 2, 3, 4];
const isQuad = value => Number.isInteger(value) && value >= 1 && value <= 4;

function quarterIndex(quarter) {
  const match = /^(\d{4})-Q([1-4])$/.exec(quarter || '');
  return match ? Number(match[1]) * 4 + Number(match[2]) - 1 : null;
}

function episodeIndices(labels, quad) {
  const episodes = [];
  let current = null;
  labels.forEach((label, index) => {
    if (label !== quad) {
      current = null;
    } else {
      if (!current) {
        current = [];
        episodes.push(current);
      }
      current.push(index);
    }
  });
  return episodes;
}

function competitionRanks(means) {
  return means.map(mean => Number.isFinite(mean)
    ? 1 + means.filter(other => other > mean).length
    : null);
}

function summarize(rows, symbols, labels, quad, excludedIndices = new Set()) {
  const indices = labels.flatMap((label, index) => label === quad && !excludedIndices.has(index) ? [index] : []);
  const count = indices.length;
  const means = symbols.map(symbol => count
    ? indices.reduce((sum, index) => sum + rows[index].returns[symbol], 0) / count
    : null);
  return {
    observations: count,
    episodes: episodeIndices(labels, quad).length,
    means,
    ranks: competitionRanks(means),
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(groupId, blockLength) {
  let hash = METHODOLOGY.seed;
  for (const character of `${groupId}:${blockLength}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

// Ordinary non-circular moving blocks: only observed adjacent quarters occur
// inside a block. All peers and the original macro label travel together.
function movingBlockIndices(length, blockLength, random) {
  if (!Number.isInteger(length) || blockLength > length || blockLength < 1) return [];
  const sampled = [];
  while (sampled.length < length) {
    const start = Math.floor(random() * (length - blockLength + 1));
    for (let offset = 0; offset < blockLength && sampled.length < length; offset += 1) {
      sampled.push(start + offset);
    }
  }
  return sampled;
}

function empiricalRankInterval(ranks) {
  if (!ranks.length) return null;
  const sorted = [...ranks].sort((left, right) => left - right);
  // Inverse empirical CDF (nearest-rank quantiles), without interpolation.
  const quantile = probability => sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
  return {
    lower: quantile(METHODOLOGY.bootstrap.lowerQuantile),
    upper: quantile(METHODOLOGY.bootstrap.upperQuantile),
  };
}

function bootstrapGate({ interval, invalidDraws, draws }, pointRank) {
  if (invalidDraws / draws > METHODOLOGY.bootstrap.maximumInvalidFraction) {
    return 'Too many bootstrap draws have no usable observations for this Quad.';
  }
  if (!interval || !Number.isFinite(pointRank)) return 'Bootstrap rank uncertainty is unavailable.';
  if (pointRank < interval.lower || pointRank > interval.upper) return 'Bootstrap rank interval excludes the observed rank.';
  if (interval.upper - interval.lower > METHODOLOGY.bootstrap.maximumRankIntervalWidth) {
    return 'Bootstrap rank interval spans more than two positions.';
  }
  return null;
}

function sensitivityGate(summary, peerIndex, pointRank) {
  if (summary.observations < METHODOLOGY.sensitivity.minimumQuadQuarters
      || summary.episodes < METHODOLOGY.sensitivity.minimumEpisodes) {
    return 'Too few quarters or episodes to evaluate macro-label sensitivity.';
  }
  if (!Number.isFinite(summary.ranks[peerIndex])
      || Math.abs(summary.ranks[peerIndex] - pointRank) > METHODOLOGY.sensitivity.maximumRankShift) {
    return 'Rank changes by more than two positions under macro-label sensitivity.';
  }
  return null;
}

function leaveEpisodeGate(summary, peerIndex, pointRank) {
  if (summary.observations < METHODOLOGY.sensitivity.minimumLeaveEpisodeQuarters) {
    return 'Fewer than four target-Quad quarters remain after removing an episode.';
  }
  if (!Number.isFinite(summary.ranks[peerIndex])
      || Math.abs(summary.ranks[peerIndex] - pointRank) > METHODOLOGY.sensitivity.maximumRankShift) {
    return 'Rank changes by more than two positions when a regime episode is removed.';
  }
  return null;
}

function bootstrapRanks(rows, symbols, eligibleQuads, groupId) {
  const results = {};
  for (const blockLength of METHODOLOGY.bootstrap.blockLengths) {
    const random = seededRandom(seedFor(groupId, blockLength));
    const samples = Object.fromEntries(eligibleQuads.map(quad => [quad, {
      invalidDraws: 0,
      ranks: symbols.map(() => []),
    }]));
    const eligible = new Set(eligibleQuads);
    for (let draw = 0; draw < METHODOLOGY.bootstrap.draws; draw += 1) {
      const sums = Array.from({ length: 5 }, () => symbols.map(() => 0));
      const counts = Array(5).fill(0);
      const indices = movingBlockIndices(rows.length, blockLength, random);
      for (const index of indices) {
        const row = rows[index];
        if (!eligible.has(row.quad)) continue;
        counts[row.quad] += 1;
        symbols.forEach((symbol, peerIndex) => { sums[row.quad][peerIndex] += row.returns[symbol]; });
      }
      for (const quad of eligibleQuads) {
        const means = counts[quad] ? sums[quad].map(sum => sum / counts[quad]) : [];
        if (!counts[quad] || means.some(mean => !Number.isFinite(mean))) {
          samples[quad].invalidDraws += 1;
          continue;
        }
        const ranks = competitionRanks(means);
        ranks.forEach((rank, peerIndex) => samples[quad].ranks[peerIndex].push(rank));
      }
    }
    for (const quad of eligibleQuads) {
      if (!results[quad]) results[quad] = {};
      const sample = samples[quad];
      results[quad][blockLength] = {
        seed: seedFor(groupId, blockLength),
        draws: METHODOLOGY.bootstrap.draws,
        invalidDraws: sample.invalidDraws,
        validDraws: METHODOLOGY.bootstrap.draws - sample.invalidDraws,
        intervals: sample.ranks.map(empiricalRankInterval),
      };
    }
  }
  return results;
}

function validateGroup(group, rows, suppliedIssues) {
  const issues = [...suppliedIssues];
  const benchmarks = Array.isArray(group?.benchmarks) ? group.benchmarks : [];
  if (!group?.id) issues.push('Missing group identifier.');
  if (!benchmarks.length) issues.push('Missing benchmark peers.');
  const exposureIds = new Set();
  const symbols = new Set();
  benchmarks.forEach(benchmark => {
    if (!benchmark.exposureId || !benchmark.symbol) issues.push('A benchmark has no exposure identifier or symbol.');
    if (exposureIds.has(benchmark.exposureId)) issues.push(`Duplicate exposure: ${benchmark.exposureId}.`);
    if (symbols.has(benchmark.symbol)) issues.push(`Duplicate benchmark symbol: ${benchmark.symbol}.`);
    exposureIds.add(benchmark.exposureId);
    symbols.add(benchmark.symbol);
  });
  if (group?.startQuarter && quarterIndex(group.startQuarter) === null) issues.push('Invalid group start quarter.');
  if (rows.length && group?.startQuarter && group.startQuarter !== rows[0]?.quarter) {
    issues.push('Aligned rows do not start at the declared group start quarter.');
  }
  let previous = null;
  rows.forEach((row, index) => {
    const current = quarterIndex(row?.quarter);
    if (current === null) issues.push(`Invalid quarter at row ${index}.`);
    if (index && current !== null && previous !== null && current !== previous + 1) {
      issues.push(`Duplicate, out-of-order, or missing calendar quarter at ${row.quarter}.`);
    }
    previous = current;
    for (const property of ['quad', 'latestQuad']) {
      if (row?.[property] !== null && !isQuad(row?.[property])) issues.push(`Invalid ${property} at ${row?.quarter}.`);
    }
    if (isQuad(row?.quad) && (!Number.isFinite(row.growthAcceleration) || !Number.isFinite(row.inflationAcceleration))) {
      issues.push(`Missing finite macro acceleration at ${row.quarter}.`);
    }
    for (const symbol of symbols) {
      if (!Number.isFinite(row?.returns?.[symbol])) issues.push(`Missing or non-finite ${symbol} return at ${row?.quarter}.`);
    }
  });
  return [...new Set(issues)];
}

function calculateGroup({ group, rows, issues = [] } = {}) {
  const alignedRows = Array.isArray(rows) ? rows : [];
  const benchmarks = Array.isArray(group?.benchmarks) ? group.benchmarks : [];
  const inputIssues = validateGroup(group, alignedRows, [
    ...(Array.isArray(issues) ? issues : ['Invalid supplied issues list.']),
    ...(!Array.isArray(rows) ? ['Missing aligned quarter rows.'] : []),
  ]);
  const result = {
    groupId: group?.id || null,
    peerCount: benchmarks.length,
    sampleStart: alignedRows[0]?.quarter || null,
    sampleEnd: alignedRows.at(-1)?.quarter || null,
    observations: alignedRows.length,
    issues: inputIssues,
    cells: [],
  };
  if (inputIssues.length) {
    result.cells = benchmarks.flatMap(benchmark => QUADS.map(quad => ({
      exposureId: benchmark.exposureId, quad, status: 'unavailable', classification: 'insufficient history',
      rank: null, peerCount: benchmarks.length, meanReturn: null, observations: 0, episodes: 0, rankInterval: null,
      reason: 'Aligned source data failed validation.', diagnostics: { gate: 'aligned-input', issues: inputIssues },
    })));
    return result;
  }

  const symbols = benchmarks.map(benchmark => benchmark.symbol);
  const labels = alignedRows.map(row => row.quad);
  const baseline = Object.fromEntries(QUADS.map(quad => [quad, summarize(alignedRows, symbols, labels, quad)]));
  const historyReasons = Object.fromEntries(QUADS.map(quad => [quad,
    alignedRows.length < METHODOLOGY.minimumOverallQuarters ? 'Fewer than 32 common calendar quarters.'
      : baseline[quad].observations < METHODOLOGY.minimumQuadQuarters ? 'Fewer than eight target-Quad quarters.'
        : baseline[quad].episodes < METHODOLOGY.minimumEpisodes ? 'Fewer than three distinct target-Quad episodes.' : null,
  ]));
  const eligibleQuads = QUADS.filter(quad => !historyReasons[quad]);
  const bootstraps = eligibleQuads.length ? bootstrapRanks(alignedRows, symbols, eligibleQuads, group.id) : {};
  const variantLabels = {
    latestVintage: alignedRows.map(row => row.latestQuad),
    nearBoundaryExcluded: alignedRows.map(row => (
      Number.isFinite(row.growthAcceleration) && Number.isFinite(row.inflationAcceleration)
      && Math.abs(row.growthAcceleration) > METHODOLOGY.sensitivity.boundaryPercentagePoints
      && Math.abs(row.inflationAcceleration) > METHODOLOGY.sensitivity.boundaryPercentagePoints
        ? row.quad : null
    )),
  };
  const variants = Object.fromEntries(eligibleQuads.map(quad => [quad,
    Object.fromEntries(Object.entries(variantLabels).map(([name, variant]) => [name, summarize(alignedRows, symbols, variant, quad)])),
  ]));
  const leaveEpisodes = Object.fromEntries(eligibleQuads.map(quad => [quad,
    episodeIndices(labels, quad).map(indices => ({
      excludedQuarters: indices.map(index => alignedRows[index].quarter),
      ...summarize(alignedRows, symbols, labels, quad, new Set(indices)),
    })),
  ]));

  result.cells = benchmarks.flatMap((benchmark, peerIndex) => QUADS.map(quad => {
    const base = baseline[quad];
    const pointRank = base.ranks[peerIndex];
    const cell = {
      exposureId: benchmark.exposureId, quad, status: 'unavailable', classification: 'insufficient history',
      rank: null, peerCount: benchmarks.length, meanReturn: base.means[peerIndex],
      observations: base.observations, episodes: base.episodes, rankInterval: null,
      reason: historyReasons[quad], diagnostics: { pointRank, gate: 'history' },
    };
    if (cell.reason) return cell;

    const failures = [];
    cell.classification = 'unstable';
    cell.diagnostics = { pointRank, bootstrap: {}, sensitivities: {}, leaveEpisodes: [] };
    for (const blockLength of METHODOLOGY.bootstrap.blockLengths) {
      const bootstrap = bootstraps[quad][blockLength];
      const detail = {
        blockLength, seed: bootstrap.seed, draws: bootstrap.draws,
        validDraws: bootstrap.validDraws, invalidDraws: bootstrap.invalidDraws,
        interval: bootstrap.intervals[peerIndex],
      };
      detail.reason = bootstrapGate(detail, pointRank);
      cell.diagnostics.bootstrap[blockLength] = detail;
      if (detail.reason) failures.push(`${blockLength}-quarter blocks: ${detail.reason}`);
    }
    const intervals = Object.values(cell.diagnostics.bootstrap).map(detail => detail.interval).filter(Boolean);
    // Display the full sensitivity envelope. Publication gates above apply to
    // each block interval separately, never to the envelope's combined width.
    cell.rankInterval = intervals.length ? {
      lower: Math.min(...intervals.map(interval => interval.lower)),
      upper: Math.max(...intervals.map(interval => interval.upper)),
    } : null;
    for (const [name, summary] of Object.entries(variants[quad])) {
      const detail = {
        rank: summary.ranks[peerIndex], observations: summary.observations, episodes: summary.episodes,
        reason: sensitivityGate(summary, peerIndex, pointRank),
      };
      cell.diagnostics.sensitivities[name] = detail;
      if (detail.reason) failures.push(`${name}: ${detail.reason}`);
    }
    for (const summary of leaveEpisodes[quad]) {
      const detail = {
        excludedQuarters: summary.excludedQuarters, observations: summary.observations,
        rank: summary.ranks[peerIndex], reason: leaveEpisodeGate(summary, peerIndex, pointRank),
      };
      cell.diagnostics.leaveEpisodes.push(detail);
      if (detail.reason) failures.push(detail.reason);
    }
    cell.diagnostics.failures = failures;
    cell.reason = failures[0] || null;
    if (!failures.length) {
      cell.status = 'supported';
      cell.classification = 'filled';
      cell.rank = pointRank;
    }
    return cell;
  }));
  return result;
}

module.exports = {
  METHODOLOGY, calculateGroup,
  // Small pure helpers keep boundary-condition tests independent of random draws.
  quarterIndex, episodeIndices, competitionRanks, summarize, seededRandom,
  movingBlockIndices, empiricalRankInterval, bootstrapGate, sensitivityGate, leaveEpisodeGate,
};
