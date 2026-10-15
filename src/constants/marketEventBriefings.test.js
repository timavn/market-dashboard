import { getMarketEventBriefing } from './marketEventBriefings';

test.each([
  ['US', 'Non-Farm Employment Change', 'U.S. Bureau of Labor Statistics'],
  ['US', 'Average Hourly Earnings m/m', 'U.S. Bureau of Labor Statistics'],
  ['US', 'Unemployment Rate', 'U.S. Bureau of Labor Statistics'],
  ['CA', 'Unemployment Rate', 'Statistics Canada'],
  ['CA', 'Employment Change', 'Statistics Canada'],
  ['UK', 'BOE Gov Bailey Speaks', 'Bank of England'],
  ['CA', 'Overnight Rate', 'Bank of Canada'],
  ['US', 'ISM Manufacturing PMI', 'Institute for Supply Management (ISM)'],
])('%s %s resolves to its own publisher', (countryCode, name, publisher) => {
  expect(getMarketEventBriefing({ countryCode, name }).publisher).toBe(publisher);
});

test.each([
  ['US', 'ADP Non-Farm Employment Change'],
  ['UK', 'Unemployment Rate'],
  ['JP', 'CPI y/y'],
])('does not assign another series publisher to %s %s', (countryCode, name) => {
  const info = getMarketEventBriefing({ countryCode, name, category: 'employment', currency: 'USD' });
  expect(info.publisher).toBe('Not verified for this series');
  expect(info.sourceUrl).toBeUndefined();
});
