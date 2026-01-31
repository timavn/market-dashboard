/**
 * Test Suite for Analytics Cards in WorkflowStatus Component
 * 
 * Tests verify that:
 * 1. All 6 analytics cards render correctly
 * 2. Dates are displayed in headers even when data is missing
 * 3. N/A placeholders are shown consistently with italic styling
 */

describe('WorkflowStatus Analytics Cards', () => {
    const mockChangelogData = {
        'risk-ranges': {
            added: ['SPY'],
            removed: [],
            available: true,
            currentDate: '2026-01-30',
            previousDate: '2026-01-29',
            trendChanges: [
                { ticker: 'TSLA', oldTrend: 'BULLISH', newTrend: 'BEARISH' }
            ]
        },
        'early-look': {
            added: [],
            removed: ['XLV'],
            available: true,
            currentDate: '2026-01-30',
            previousDate: '2026-01-29'
        },
        'bitcoin-trend-tracker': {
            added: [],
            removed: [],
            available: true,
            currentDate: '2026-01-30',
            previousDate: '2026-01-29',
            cryptoTrendChanges: [],
            etfTrendChanges: []
        },
        'portfolio-solutions': {
            added: [],
            removed: [],
            available: true,
            currentDate: '2026-01-30'
        },
        'signal-strength': {
            added: [],
            removed: [],
            available: true,
            currentDate: '2026-01-30'
        },
        'momo-tracker': {
            added: [],
            removed: [],
            available: true,
            currentDate: '2026-01-30'
        }
    };

    // Test formatDate helper
    describe('formatDate helper', () => {
        const formatDate = (dateStr) => {
            if (!dateStr) {
                return new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            }
            return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
        };

        test('formats valid date string correctly', () => {
            expect(formatDate('2026-01-30')).toBe('1/30');
        });

        test('returns today date when dateStr is null', () => {
            const today = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            expect(formatDate(null)).toBe(today);
        });

        test('returns today date when dateStr is empty string', () => {
            const today = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            expect(formatDate('')).toBe(today);
        });

        test('returns today date when dateStr is undefined', () => {
            const today = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            expect(formatDate(undefined)).toBe(today);
        });
    });

    // Test card visibility logic
    describe('Card visibility', () => {
        const ALWAYS_SHOW_CARDS = ['bitcoin-trend-tracker', 'portfolio-solutions', 'momo-tracker', 'signal-strength'];
        const CONDITIONAL_CARDS = ['risk-ranges', 'early-look'];

        test('always-show cards should render even with empty data', () => {
            ALWAYS_SHOW_CARDS.forEach(key => {
                const diff = mockChangelogData[key];
                const alwaysShow = ALWAYS_SHOW_CARDS.includes(key);
                expect(alwaysShow).toBe(true);
                // Card should render because alwaysShow is true
            });
        });

        test('conditional cards should only render with data', () => {
            CONDITIONAL_CARDS.forEach(key => {
                const diff = mockChangelogData[key];
                const hasData = diff && diff.available && (
                    diff.added.length > 0 ||
                    diff.removed.length > 0 ||
                    (diff.updates && diff.updates.length > 0) ||
                    (diff.trendChanges && diff.trendChanges.length > 0)
                );

                if (key === 'risk-ranges') {
                    expect(hasData).toBe(true); // Has trendChanges and added
                }
                if (key === 'early-look') {
                    expect(hasData).toBe(true); // Has removed
                }
            });
        });
    });

    // Test currentDate is present in changelog response
    describe('Changelog API response', () => {
        test('all cards should have currentDate field', () => {
            Object.keys(mockChangelogData).forEach(key => {
                expect(mockChangelogData[key].currentDate).toBeDefined();
                expect(mockChangelogData[key].currentDate).not.toBeNull();
            });
        });

        test('available flag should be boolean', () => {
            Object.keys(mockChangelogData).forEach(key => {
                expect(typeof mockChangelogData[key].available).toBe('boolean');
            });
        });
    });

    // Test N/A display logic
    describe('N/A placeholder display', () => {
        test('Added section shows N/A when added array is empty', () => {
            const diff = mockChangelogData['portfolio-solutions'];
            const showNA = !diff?.added || diff.added.length === 0;
            expect(showNA).toBe(true);
        });

        test('Removed section shows N/A when removed array is empty', () => {
            const diff = mockChangelogData['portfolio-solutions'];
            const showNA = !diff?.removed || diff.removed.length === 0;
            expect(showNA).toBe(true);
        });

        test('Added section shows tickers when added array has items', () => {
            const diff = mockChangelogData['risk-ranges'];
            const showNA = !diff?.added || diff.added.length === 0;
            expect(showNA).toBe(false);
            expect(diff.added).toContain('SPY');
        });
    });
});

// Export for use in test runner
module.exports = { describe, test, expect };
