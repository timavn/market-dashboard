/** @jest-environment node */
const {
  calculateParticipation,
  calculateVolumeTrend,
  pairSessions,
  participationRegime,
} = require('./volumeParticipation.cjs');

// Weekdays only, oldest first; holidays do not matter for pairing by date.
function sessionDates(count, end = '2026-10-23') {
  const dates = [];
  let cursor = new Date(`${end}T00:00:00Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return dates;
}

// Alternating up/down closes; up sessions trade upVolume, down sessions downVolume.
function market({ count = 70, upVolume = 12, downVolume = 10 } = {}) {
  const dates = sessionDates(count + 1);
  const closes = dates.map((date, index) => ({ date, close: 100 + (index % 2) }));
  const volumeRows = dates.slice(1).map((date, index) => ({
    date, volume: (index % 2 === 0 ? upVolume : downVolume) * 1e9,
  }));
  return { closes, volumeRows };
}

describe('volume participation', () => {
  test('labels heavier up-session volume as accumulation', () => {
    const { closes, volumeRows } = market({ upVolume: 12, downVolume: 10 });
    const result = calculateParticipation(volumeRows, closes);
    expect(result.status).toBe('ok');
    expect(result.asOf).toBe('2026-10-23');
    expect(result.windows['1m'].upDownRatio).toBeCloseTo(1.2);
    expect(result.regime).toBe('accumulation');
    expect(result.windows['3m'].sessions).toBe(63);
  });

  test('labels heavier down-session volume as distribution and grades the latest session', () => {
    const { closes, volumeRows } = market({ upVolume: 8, downVolume: 10 });
    const result = calculateParticipation(volumeRows, closes);
    expect(result.regime).toBe('distribution');
    // The latest session (index 69) is a down close on above-average volume.
    expect(result.latest).toMatchObject({ date: '2026-10-23', signal: 'confirmed decline' });
    expect(result.latest.volumeVs1m).toBeGreaterThan(0);
  });

  test('drops sessions without a close or a prior close instead of estimating', () => {
    const { closes, volumeRows } = market({ count: 5 });
    const paired = pairSessions(volumeRows, closes.filter(row => row.date !== '2026-10-21'));
    expect(paired.map(row => row.date)).not.toContain('2026-10-21');
    expect(paired.map(row => row.date)).not.toContain('2026-10-22');
  });

  test('refuses to label a window that is short or one-sided', () => {
    const { closes, volumeRows } = market({ count: 10 });
    expect(calculateParticipation(volumeRows, closes)).toMatchObject({ status: 'unavailable', regime: 'unavailable' });
    expect(participationRegime(1.0)).toBe('balanced');
    expect(participationRegime(null)).toBe('unavailable');
  });
});

describe('volume trend', () => {
  // Newest first: the latest `recent` sessions trade `recentVolume`, the rest of the year 10B.
  function year({ recent = 21, recentVolume = 9, sessions = 252 } = {}) {
    return sessionDates(sessions).reverse().map((date, index) => ({
      date, volume: (index < recent ? recentVolume : 10) * 1e9,
    }));
  }

  test('compares recent average volume with the trailing year and reads it light', () => {
    const trend = calculateVolumeTrend(year());
    expect(trend.status).toBe('ok');
    expect(trend.asOf).toBe('2026-10-23');
    expect(trend.latest).toEqual({ date: '2026-10-23', volume: 9e9 });
    const baseline = (21 * 9 + 231 * 10) / 252;
    expect(trend.windows['1w']).toBeCloseTo(9 / baseline - 1);
    expect(trend.windows['1m']).toBeCloseTo(9 / baseline - 1);
    expect(trend.read).toBe('light');
    expect(calculateVolumeTrend(year({ recentVolume: 10 })).read).toBe('normal');
    expect(calculateVolumeTrend(year({ recentVolume: 12 })).read).toBe('heavy');
  });

  test('refuses a year it cannot fill or a window with too many incomplete sessions', () => {
    expect(calculateVolumeTrend(year({ sessions: 200 }))).toMatchObject({ status: 'unavailable', read: 'unavailable' });
    const gappy = year().map((row, index) => (index < 2 ? { ...row, volume: null } : row));
    const trend = calculateVolumeTrend(gappy);
    // Three of five sessions is too thin for 1W; 19 of 21 still averages 1M.
    expect(trend.windows['1w']).toBeNull();
    expect(trend.windows['1m']).not.toBeNull();
    expect(trend.latest.date).toBe(gappy[2].date);
  });
});
