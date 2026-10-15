'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  METHODOLOGY, calculateGroup, quarterIndex, episodeIndices, competitionRanks,
  summarize, seededRandom, movingBlockIndices, empiricalRankInterval,
  bootstrapGate, sensitivityGate, leaveEpisodeGate,
} = require('./calculation.cjs');

// Synthetic values exist only in this test module; production requires reviewed
// historical inputs and cannot import these fixtures.
function fixture({ count = 48, peers = 5 } = {}) {
  const symbols = Array.from({ length: peers }, (_, index) => `PEER${index + 1}`);
  const rows = Array.from({ length: count }, (_, index) => {
    const quad = Math.floor(index / 3) % 4 + 1;
    return {
      quarter: `${2014 + Math.floor(index / 4)}-Q${index % 4 + 1}`,
      quad,
      latestQuad: quad,
      growthAcceleration: quad <= 2 ? 0.5 : -0.5,
      inflationAcceleration: quad === 2 || quad === 3 ? 0.5 : -0.5,
      returns: Object.fromEntries(symbols.map((symbol, peer) => [symbol, (peers - peer) / 100 + Math.sin(index) / 1000])),
    };
  });
  return {
    group: {
      id: 'test-category', label: 'Test category', startQuarter: rows[0]?.quarter,
      benchmarks: symbols.map(symbol => ({ exposureId: `factor-${symbol}`, label: symbol, symbol })),
    },
    rows,
  };
}

const cellFor = (result, quad, peer = 1) => result.cells.find(cell => cell.quad === quad && cell.exposureId === `factor-PEER${peer}`);

test('methodology thresholds are fixed and nested configuration is immutable', () => {
  assert.equal(METHODOLOGY.minimumOverallQuarters, 32);
  assert.equal(METHODOLOGY.minimumQuadQuarters, 8);
  assert.equal(METHODOLOGY.minimumEpisodes, 3);
  assert.equal(METHODOLOGY.bootstrap.draws, 5000);
  assert.deepEqual(METHODOLOGY.bootstrap.blockLengths, [2, 4, 8]);
  assert.equal(METHODOLOGY.sensitivity.boundaryPercentagePoints, 0.1);
  assert.throws(() => { METHODOLOGY.bootstrap.draws = 10; }, TypeError);
  assert.throws(() => { METHODOLOGY.bootstrap.blockLengths.push(16); }, TypeError);
});

test('calendar validation recognizes year boundaries and rejects invalid quarters', () => {
  assert.equal(quarterIndex('2026-Q1') - quarterIndex('2025-Q4'), 1);
  assert.equal(quarterIndex('2026-Q5'), null);
  assert.equal(quarterIndex('26-Q1'), null);
});

test('episodes follow the entire calendar and unclassified quarters break an episode', () => {
  assert.deepEqual(episodeIndices([1, 1, null, 1, 2, 1, 1], 1), [[0, 1], [3], [5, 6]]);
  assert.deepEqual(episodeIndices([2, null, 3], 1), []);
});

test('means use arithmetic decimal total returns and competition ranks retain exact ties', () => {
  const rows = [
    { returns: { A: 0.2, B: 0.1 } },
    { returns: { A: -0.1, B: 0.1 } },
    { returns: { A: 0.9, B: 0.9 } },
  ];
  const result = summarize(rows, ['A', 'B'], [1, 1, 2], 1);
  assert.deepEqual(result.means, [0.05, 0.1]);
  assert.deepEqual(result.ranks, [2, 1]);
  assert.deepEqual(competitionRanks([0.1, 0.1, 0.05]), [1, 1, 3]);
  assert.deepEqual(competitionRanks([0.1 + 1e-14, 0.1, 0.05]), [1, 2, 3]);
});

test('moving blocks contain observed adjacent indices, preserve length, and reproduce with the seed', () => {
  const first = movingBlockIndices(11, 4, seededRandom(42));
  assert.deepEqual(first, movingBlockIndices(11, 4, seededRandom(42)));
  assert.equal(first.length, 11);
  for (let start = 0; start < first.length; start += 4) {
    for (let offset = 1; offset < 4 && start + offset < first.length; offset += 1) {
      assert.equal(first[start + offset], first[start] + offset);
    }
  }
  assert.ok(first.every(index => index >= 0 && index < 11));
  assert.deepEqual(movingBlockIndices(3, 4, seededRandom(42)), []);
});

test('empirical 80% intervals use nearest empirical ranks without interpolation', () => {
  assert.deepEqual(empiricalRankInterval([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), { lower: 1, upper: 9 });
  assert.deepEqual(empiricalRankInterval([3, 3, 3]), { lower: 3, upper: 3 });
  assert.equal(empiricalRankInterval([]), null);
});

test('bootstrap gates reject invalid draws, excessive width, and exclusion of the point rank', () => {
  const base = { interval: { lower: 2, upper: 4 }, invalidDraws: 500, draws: 5000 };
  assert.equal(bootstrapGate(base, 3), null);
  assert.match(bootstrapGate({ ...base, invalidDraws: 501 }, 3), /Too many/);
  assert.match(bootstrapGate({ ...base, interval: { lower: 1, upper: 4 } }, 3), /more than two/);
  assert.match(bootstrapGate(base, 1), /excludes/);
  assert.match(bootstrapGate({ ...base, interval: null }, 3), /unavailable/);
});

test('macro sensitivity and leave-episode gates have separate prespecified sample floors', () => {
  const summary = { observations: 6, episodes: 2, ranks: [4] };
  assert.equal(sensitivityGate(summary, 0, 2), null);
  assert.match(sensitivityGate({ ...summary, observations: 5 }, 0, 2), /Too few/);
  assert.match(sensitivityGate({ ...summary, episodes: 1 }, 0, 2), /Too few/);
  assert.match(sensitivityGate(summary, 0, 1), /more than two/);
  assert.equal(leaveEpisodeGate({ observations: 4, episodes: 2, ranks: [3] }, 0, 1), null);
  assert.match(leaveEpisodeGate({ observations: 3, ranks: [1] }, 0, 1), /Fewer than four/);
  assert.match(leaveEpisodeGate({ observations: 4, ranks: [4] }, 0, 1), /more than two/);
});

test('complete seeded calculation performs every 5000-draw bootstrap and is deterministic', () => {
  const input = fixture();
  const original = JSON.stringify(input);
  const first = calculateGroup(input);
  const second = calculateGroup(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), original, 'Calculation must not mutate source snapshots.');
  assert.deepEqual(first.issues, []);
  assert.equal(first.cells.length, 20);
  assert.equal(first.sampleStart, '2014-Q1');
  assert.equal(first.sampleEnd, '2025-Q4');
  for (const quad of [1, 2, 3, 4]) {
    for (let peer = 1; peer <= 5; peer += 1) {
      const cell = cellFor(first, quad, peer);
      assert.equal(cell.status, 'supported');
      assert.equal(cell.classification, 'filled');
      assert.equal(cell.rank, peer);
      assert.equal(cell.observations, 12);
      assert.equal(cell.episodes, 4);
      assert.deepEqual(cell.rankInterval, { lower: peer, upper: peer });
      for (const length of [2, 4, 8]) {
        const bootstrap = cell.diagnostics.bootstrap[length];
        assert.equal(bootstrap.draws, 5000);
        assert.equal(bootstrap.validDraws + bootstrap.invalidDraws, 5000);
        assert.equal(bootstrap.reason, null);
      }
    }
  }
});

test('supplied issues and invalid aligned inputs withhold the complete cohort', () => {
  const cases = [
    ['source issues', input => { input.issues = ['Distribution adjustment has not been verified.']; }],
    ['missing peer return', input => { delete input.rows[0].returns.PEER2; }],
    ['nonfinite return', input => { input.rows[0].returns.PEER2 = Number.NaN; }],
    ['numeric string return', input => { input.rows[0].returns.PEER2 = '0.02'; }],
    ['duplicate quarter', input => { input.rows[1].quarter = input.rows[0].quarter; }],
    ['out of order', input => { [input.rows[1], input.rows[2]] = [input.rows[2], input.rows[1]]; }],
    ['missing quarter', input => { input.rows.splice(1, 1); }],
    ['incorrect start', input => { input.group.startQuarter = '2013-Q4'; }],
    ['duplicate peer', input => { input.group.benchmarks[1].symbol = 'PEER1'; }],
    ['invalid label', input => { input.rows[0].quad = 5; }],
    ['missing latest vintage label', input => { delete input.rows[0].latestQuad; }],
    ['missing acceleration', input => { input.rows[0].growthAcceleration = null; }],
  ];
  for (const [name, mutate] of cases) {
    const input = fixture();
    mutate(input);
    const result = calculateGroup(input);
    assert.ok(result.issues.length, name);
    assert.ok(result.cells.every(cell => cell.status === 'unavailable' && cell.rank === null), name);
  }
});

test('each baseline history gate withholds a rank without running uncertainty calculations', () => {
  const short = calculateGroup(fixture({ count: 31 }));
  assert.match(cellFor(short, 1).reason, /32 common/);
  const few = fixture();
  let seen = 0;
  few.rows.forEach(row => { if (row.quad === 1 && ++seen > 7) row.quad = null; });
  assert.match(cellFor(calculateGroup(few), 1).reason, /eight target/);
  const concentrated = fixture();
  concentrated.rows.forEach((row, index) => {
    row.quad = index < 10 ? 1 : 2;
    row.latestQuad = row.quad;
  });
  assert.match(cellFor(calculateGroup(concentrated), 1).reason, /three distinct/);
  assert.equal(cellFor(short, 1).classification, 'insufficient history');
  assert.equal(cellFor(short, 1).diagnostics.bootstrap, undefined);
});

test('unclassified quarters remain on the calendar and never become neutral observations', () => {
  const input = fixture();
  for (const index of [0, 12, 24]) {
    input.rows[index].quad = null;
    input.rows[index].latestQuad = null;
    input.rows[index].growthAcceleration = 0;
  }
  const result = calculateGroup(input);
  assert.deepEqual(result.issues, []);
  assert.equal(result.observations, 48);
  assert.equal(cellFor(result, 1).observations, 9);
  assert.equal(cellFor(result, 1).episodes, 4);
});

test('latest-vintage rank reversal withholds the affected peers despite stable baseline ranks', () => {
  const input = fixture();
  input.rows.forEach(row => {
    if (row.quad === 1) row.latestQuad = 2;
    if (row.quad === 2) {
      row.latestQuad = 1;
      row.returns = Object.fromEntries(Object.keys(row.returns).map((symbol, index) => [symbol, (index + 1) / 100]));
    }
  });
  const result = calculateGroup(input);
  const first = cellFor(result, 1, 1);
  assert.equal(first.status, 'unavailable');
  assert.equal(first.classification, 'unstable');
  assert.equal(first.rank, null);
  assert.equal(first.diagnostics.sensitivities.latestVintage.rank, 5);
  assert.match(first.diagnostics.sensitivities.latestVintage.reason, /more than two/);
  assert.equal(cellFor(result, 1, 3).status, 'supported');
});

test('near-boundary exclusion includes exactly ±0.1pp and withholds untestable sensitivity', () => {
  const input = fixture();
  input.rows.forEach(row => {
    if (row.quad === 1) row.growthAcceleration = 0.1;
    if (row.quad === 3) row.growthAcceleration = -0.1;
  });
  const result = calculateGroup(input);
  for (const quad of [1, 3]) {
    const cell = cellFor(result, quad);
    assert.equal(cell.classification, 'unstable');
    assert.equal(cell.diagnostics.sensitivities.nearBoundaryExcluded.observations, 0);
    assert.match(cell.diagnostics.sensitivities.nearBoundaryExcluded.reason, /Too few/);
  }
});

test('deleting a dominant episode with too few remaining observations withholds the result', () => {
  const input = fixture();
  input.rows.forEach((row, index) => {
    row.quad = index < 6 || index === 20 || index === 40 ? 1 : 2;
    row.latestQuad = row.quad;
  });
  const result = calculateGroup(input);
  const cell = cellFor(result, 1);
  assert.equal(cell.observations, 8);
  assert.equal(cell.episodes, 3);
  assert.equal(cell.rank, null);
  assert.ok(cell.diagnostics.leaveEpisodes.some(detail => detail.observations === 2 && /Fewer than four/.test(detail.reason)));
});

test('missing arguments return an explicit invalid result rather than inventing peers', () => {
  const result = calculateGroup();
  assert.equal(result.groupId, null);
  assert.ok(result.issues.length);
  assert.deepEqual(result.cells, []);
});
