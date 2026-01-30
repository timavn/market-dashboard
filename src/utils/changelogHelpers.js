/**
 * Changelog helper utilities
 * Extracted for testability and reuse
 */

/**
 * Normalize an OutBucket item to a display string.
 * Handles both string and object formats.
 * @param {string|object} item - The OutBucket item
 * @returns {string} - Normalized display string
 */
const normalizeOutbucketItem = (item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
        const name = item.name || 'Unknown';
        const ticker = item.ticker || item.symbol || '';
        const trend = item.trend || '';
        if (ticker) return `${name} (${ticker}) - ${trend}`;
        return name;
    }
    return String(item);
};

/**
 * Extract ticker symbol from an OutBucket item for comparison.
 * @param {string|object} item - The OutBucket item
 * @returns {string} - Ticker symbol or fallback string
 */
const extractTicker = (item) => {
    if (typeof item === 'string') {
        const match = item.match(/\(([^)]+)\)/);
        return match ? match[1] : item;
    }
    if (item && typeof item === 'object') {
        return item.ticker || item.symbol || JSON.stringify(item);
    }
    return String(item);
};

/**
 * Compute the diff between two OutBucket arrays.
 * @param {Array} currentOutbucket - Current day's OutBucket list
 * @param {Array} previousOutbucket - Previous day's OutBucket list
 * @returns {{ added: string[], removed: string[] }} - Diff result with normalized strings
 */
const computeOutbucketDiff = (currentOutbucket, previousOutbucket) => {
    if (!currentOutbucket && !previousOutbucket) {
        return { added: [], removed: [] };
    }

    if (!previousOutbucket) {
        return {
            added: (currentOutbucket || []).map(normalizeOutbucketItem),
            removed: []
        };
    }

    if (!currentOutbucket) {
        return {
            added: [],
            removed: previousOutbucket.map(normalizeOutbucketItem)
        };
    }

    const currOut = currentOutbucket.map(extractTicker);
    const prevOut = previousOutbucket.map(extractTicker);

    const added = currentOutbucket
        .filter(item => !prevOut.includes(extractTicker(item)))
        .map(normalizeOutbucketItem);

    const removed = previousOutbucket
        .filter(item => !currOut.includes(extractTicker(item)))
        .map(normalizeOutbucketItem);

    return { added, removed };
};

module.exports = {
    normalizeOutbucketItem,
    extractTicker,
    computeOutbucketDiff
};
