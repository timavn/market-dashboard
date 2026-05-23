import { formatIbkrAccountLabel } from './ibkrAccountLabels';

describe('formatIbkrAccountLabel', () => {
  it('labels Individual account ending in 9973', () => {
    expect(formatIbkrAccountLabel('U25779973')).toBe('Individual (U25779973)');
  });

  it('labels Roth IRA account', () => {
    expect(formatIbkrAccountLabel('U25465536')).toBe('Roth IRA (U25465536)');
  });

  it('falls back to raw account id for unknown accounts', () => {
    expect(formatIbkrAccountLabel('U99999999')).toBe('U99999999');
  });
});
