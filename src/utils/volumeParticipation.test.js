/** @jest-environment node */
const {
  calculateParticipation,
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
