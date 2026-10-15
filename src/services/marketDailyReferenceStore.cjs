'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { threadId } = require('node:worker_threads');
const { retainMarketDailyReference, validateMarketDailyReference } = require('../utils/marketDailyReference.cjs');
const DEFAULT_REFERENCE_PATH = path.join(process.cwd(), 'data', 'market-daily', 'last-verified-v1.json');

function createMarketDailyReferenceStore({ referencePath = DEFAULT_REFERENCE_PATH, now = Date.now } = {}) {
  return {
    read() {
      if (!referencePath) return null;
      try {
        const stored = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
        return stored.schemaVersion === 1 ? retainMarketDailyReference(stored.snapshot, Number(now())) : null;
      } catch { return null; }
    },
    write(snapshot) {
      const verified = validateMarketDailyReference(snapshot, Number(now()));
      if (!referencePath || !verified) return;
      try {
        fs.mkdirSync(path.dirname(referencePath), { recursive: true, mode: 0o700 });
        const temporary = `${referencePath}.${process.pid}.${threadId}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, snapshot: verified }), { mode: 0o600 });
        fs.renameSync(temporary, referencePath);
      } catch { /* An unwritable reference store must not hide verified data. */ }
    },
  };
}

module.exports = { createMarketDailyReferenceStore, DEFAULT_REFERENCE_PATH };
