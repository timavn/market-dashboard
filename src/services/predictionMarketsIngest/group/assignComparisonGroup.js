const { comparisonFingerprint } = require('../normalize/normalizeEvent');

/**
 * @param {object[]} events
 * @returns {object[]}
 */
function assignComparisonGroup(events) {
  const groups = new Map();

  return events.map((event) => {
    const fp = comparisonFingerprint(event);
    if (!groups.has(fp)) {
      groups.set(fp, `cg_${fp}`);
    }
    return {
      ...event,
      comparison_group_id: groups.get(fp),
    };
  });
}

module.exports = { assignComparisonGroup };
