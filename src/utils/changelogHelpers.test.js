/**
 * Unit tests for changelog helper utilities
 */

const {
    normalizeOutbucketItem,
    extractTicker,
    computeOutbucketDiff
} = require('./changelogHelpers');

describe('normalizeOutbucketItem', () => {
    test('handles string input', () => {
        const input = 'OUTBUCKET: Energy Select Sector SPDR Fund (XLE) - BULLISH - 10/8/2025';
        expect(normalizeOutbucketItem(input)).toBe(input);
    });

    test('handles object input with all properties', () => {
        const input = { name: 'Energy Select Sector SPDR Fund', ticker: 'XLE', trend: 'BULLISH' };
        expect(normalizeOutbucketItem(input)).toBe('Energy Select Sector SPDR Fund (XLE) - BULLISH');
    });

    test('handles object input with only ticker', () => {
        const input = { ticker: 'XLE' };
        expect(normalizeOutbucketItem(input)).toBe('Unknown (XLE) - ');
    });

    test('handles object with symbol instead of ticker', () => {
        const input = { name: 'Test ETF', symbol: 'TST', trend: 'BEARISH' };
        expect(normalizeOutbucketItem(input)).toBe('Test ETF (TST) - BEARISH');
    });

    test('handles object with only name', () => {
        const input = { name: 'Some Fund' };
        expect(normalizeOutbucketItem(input)).toBe('Some Fund');
    });

    test('handles null input', () => {
        expect(normalizeOutbucketItem(null)).toBe('null');
    });

    test('handles undefined input', () => {
        expect(normalizeOutbucketItem(undefined)).toBe('undefined');
    });

    test('handles number input', () => {
        expect(normalizeOutbucketItem(123)).toBe('123');
    });
});

describe('extractTicker', () => {
    test('extracts ticker from string with parentheses', () => {
        const input = 'Energy Select Sector SPDR Fund (XLE) - BULLISH';
        expect(extractTicker(input)).toBe('XLE');
    });

    test('returns full string if no parentheses', () => {
        const input = 'Some Random String';
        expect(extractTicker(input)).toBe('Some Random String');
    });

    test('extracts ticker from object', () => {
        const input = { ticker: 'XLE', name: 'Energy ETF' };
        expect(extractTicker(input)).toBe('XLE');
    });

    test('uses symbol if ticker not present', () => {
        const input = { symbol: 'TST', name: 'Test' };
        expect(extractTicker(input)).toBe('TST');
    });

    test('handles null input', () => {
        expect(extractTicker(null)).toBe('null');
    });
});

describe('computeOutbucketDiff', () => {
    test('identifies added items', () => {
        const current = [{ ticker: 'XLE', name: 'Energy', trend: 'BULLISH' }];
        const previous = [];
        const result = computeOutbucketDiff(current, previous);
        expect(result.added).toHaveLength(1);
        expect(result.added[0]).toBe('Energy (XLE) - BULLISH');
        expect(result.removed).toHaveLength(0);
    });

    test('identifies removed items', () => {
        const current = [];
        const previous = [{ ticker: 'XLU', name: 'Utilities', trend: 'BEARISH' }];
        const result = computeOutbucketDiff(current, previous);
        expect(result.added).toHaveLength(0);
        expect(result.removed).toHaveLength(1);
        expect(result.removed[0]).toBe('Utilities (XLU) - BEARISH');
    });

    test('handles mixed strings and objects', () => {
        const current = [
            'OUTBUCKET: New Fund (NEW) - BULLISH',
            { ticker: 'XLE', name: 'Energy', trend: 'BULLISH' }
        ];
        const previous = [
            { ticker: 'XLE', name: 'Energy', trend: 'BULLISH' },
            'OUTBUCKET: Old Fund (OLD) - BEARISH'
        ];
        const result = computeOutbucketDiff(current, previous);
        expect(result.added).toEqual(['OUTBUCKET: New Fund (NEW) - BULLISH']);
        expect(result.removed).toEqual(['OUTBUCKET: Old Fund (OLD) - BEARISH']);
    });

    test('handles both arrays null', () => {
        const result = computeOutbucketDiff(null, null);
        expect(result.added).toEqual([]);
        expect(result.removed).toEqual([]);
    });

    test('handles current null', () => {
        const previous = [{ ticker: 'XLE', name: 'Energy', trend: 'BULLISH' }];
        const result = computeOutbucketDiff(null, previous);
        expect(result.added).toEqual([]);
        expect(result.removed).toHaveLength(1);
    });

    test('handles previous null', () => {
        const current = [{ ticker: 'XLE', name: 'Energy', trend: 'BULLISH' }];
        const result = computeOutbucketDiff(current, null);
        expect(result.added).toHaveLength(1);
        expect(result.removed).toEqual([]);
    });
});
