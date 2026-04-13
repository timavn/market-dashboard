const {
  aggregateCboeHistoricalRows,
  buildCalibrationReport,
  buildMarketShareVolumeResponse,
  calculateSeriesComparisons
} = require('../../../utils/marketStructureVolume.cjs');

function buildIsoDateSeries(startDate, count) {
  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);

  for (let index = 0; index < count; index += 1) {
    const current = new Date(cursor);
    current.setUTCDate(cursor.getUTCDate() - index);
    dates.push(current.toISOString().slice(0, 10));
  }

  return dates;
}

function buildSyntheticBenchmarkRecords() {
  const dates = buildIsoDateSeries('2026-03-18', 253);
  const records = [];

  dates.forEach((date, index) => {
    let totalMarketVolume = 0;
    let totalExchangeVolume = 0;

    if (index === 0) {
      totalMarketVolume = 216;
      totalExchangeVolume = 115;
    } else if (index === 1) {
      totalMarketVolume = 200;
      totalExchangeVolume = 100;
    } else if (index <= 21) {
      totalMarketVolume = 195.8;
      totalExchangeVolume = 114.553;
    } else if (index <= 63) {
      totalMarketVolume = 188.5;
      totalExchangeVolume = 108.94;
    } else {
      totalMarketVolume = 186.76666666666668;
      totalExchangeVolume = 105.11333333333333;
    }

    records.push({
      date,
      totalMarketVolume,
      totalExchangeVolume,
      totalOffExchangeVolume: totalMarketVolume - totalExchangeVolume,
      methodologyVersion: 'market-structure-cboe-consolidated-v1',
      fetchedAt: '2026-03-20T00:00:00.000Z',
      status: 'ready'
    });
  });

  return records;
}

describe('marketStructureVolume helpers', () => {
  it('aggregates listed exchange and TRF rows into normalized daily records', () => {
    const records = aggregateCboeHistoricalRows([
      {
        Day: '2026-03-18',
        'Market Participant': 'NYSE (N)',
        'Total Shares': '100',
        'Total Notional': '2500'
      },
      {
        Day: '2026-03-18',
        'Market Participant': 'FINRA / NYSE TRF (DN)',
        'Total Shares': '40',
        'Total Notional': '900'
      },
      {
        Day: '2026-03-17',
        'Market Participant': 'NASDAQ (Q)',
        'Total Shares': '80',
        'Total Notional': '1200'
      }
    ]);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      date: '2026-03-18',
      totalMarketVolume: 140,
      totalExchangeVolume: 100,
      totalOffExchangeVolume: 40,
      totalMarketNotional: 3400,
      totalExchangeNotional: 2500,
      totalOffExchangeNotional: 900
    });
  });

  it('excludes the as-of day from trailing averages', () => {
    const series = [
      { date: '2026-03-18', value: 120 },
      { date: '2026-03-17', value: 100 },
      { date: '2026-03-16', value: 100 },
      { date: '2026-03-15', value: 100 }
    ];

    const metrics = calculateSeriesComparisons(series, {
      priorDay: 1,
      avg1M: 2,
      avg3M: 3,
      avg1Y: 3
    });

    expect(metrics.current).toBe(120);
    expect(metrics.priorDay).toBe(100);
    expect(metrics.avg1M).toBe(100);
    expect(Math.round(metrics.pctPriorDay)).toBe(20);
    expect(Math.round(metrics.pct1M)).toBe(20);
  });

  it('matches the benchmark percentages for a calibrated synthetic dataset', () => {
    const records = buildSyntheticBenchmarkRecords();
    const report = buildCalibrationReport(records, [
      {
        date: '2026-03-18',
        totalMarket_priorDay: 8,
        totalMarket_1M: 10,
        totalMarket_3M: 13,
        totalMarket_1Y: 15,
        totalExchange_priorDay: 15,
        totalExchange_1M: 1,
        totalExchange_3M: 4,
        totalExchange_1Y: 8
      }
    ]);

    expect(report.selected.summary.exactMatchCount).toBe(1);
    expect(report.selected.benchmarks[0].actual).toEqual({
      totalMarket_priorDay: 8,
      totalMarket_1M: 10,
      totalMarket_3M: 13,
      totalMarket_1Y: 15,
      totalExchange_priorDay: 15,
      totalExchange_1M: 1,
      totalExchange_3M: 4,
      totalExchange_1Y: 8
    });
  });

  it('builds the API response shape with metadata for the volume card', () => {
    const records = buildSyntheticBenchmarkRecords().slice(0, 5);
    const response = buildMarketShareVolumeResponse(records, {
      days: 3,
      status: 'provisional'
    });

    expect(response.asOf).toBe('2026-03-18');
    expect(response.totalMarket).toHaveLength(3);
    expect(response.totalExchange).toHaveLength(3);
    expect(response.meta).toMatchObject({
      asOfTradingDate: '2026-03-18',
      status: 'provisional',
      methodologyVersion: 'market-structure-cboe-consolidated-v1'
    });
    expect(response.meta.windows.avg1Y).toBe(252);
  });
});
