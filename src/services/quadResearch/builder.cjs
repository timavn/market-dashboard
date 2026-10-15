'use strict';

const { GROUPS, GAPS, EXCLUSIONS } = require('./catalog.cjs');
const { METHODOLOGY, calculateGroup, quarterIndex } = require('./calculation.cjs');
const { contentHash, editionIdentity, completedCutoff, independentEvidenceVerified, createSnapshotStore } = require('./snapshot.cjs');

function buildSnapshot(inputs, { inputHash = contentHash(inputs) } = {}) {
  if (!inputs || !/^\d{4}-Q[1-4]$/.test(inputs.cutoff || '') || !Array.isArray(inputs.groups)
    || !Number.isFinite(Date.parse(inputs.generatedAt)) || !Array.isArray(inputs.sourceHashes)
    || !completedCutoff(inputs.cutoff, inputs.generatedAt)) {
    throw new Error('Research input manifest is incomplete.');
  }
  const groupResults = GROUPS.map(group => {
    const candidates = inputs.groups.filter(item => item.groupId === group.id);
    const input = candidates[0];
    const issues = [...(input?.issues || [])];
    if (!independentEvidenceVerified(inputs.validation, inputs.sourceHashes)) {
      issues.push('Independent issuer and original macro-release validation is incomplete.');
    }
    if (candidates.length !== 1) issues.push('The complete, unique peer-group input is required.');
    if (input?.rows?.length && input.rows.at(-1).quarter !== inputs.cutoff) issues.push('Peer history does not reach the declared historical cutoff.');
    if (quarterIndex(inputs.cutoff) < quarterIndex(group.startQuarter)) issues.push('The cutoff precedes the defined cohort.');
    return calculateGroup({ group, rows: input?.rows || [], issues });
  });
  const cells = GAPS.map(gap => {
    const group = GROUPS.find(item => item.id === gap.groupId);
    const result = groupResults.find(item => item.groupId === gap.groupId);
    const benchmark = group?.benchmarks.find(item => item.exposureId === gap.exposureId);
    const calculated = result?.cells.find(item => item.exposureId === gap.exposureId && item.quad === gap.quad);
    if (EXCLUSIONS[gap.exposureId]) {
      return { ...gap, status: 'unavailable', classification: 'undefined', rank: null, peerCount: null,
        benchmark: null, meanReturn: null, observations: 0, episodes: 0, rankInterval: null,
        sampleStart: null, sampleEnd: null, reason: EXCLUSIONS[gap.exposureId], diagnostics: { gate: 'benchmark-definition' } };
    }
    if (!calculated || !benchmark) throw new Error('A candidate has no complete benchmark calculation.');
    return { ...gap, ...calculated, benchmark,
      sampleStart: result.sampleStart, sampleEnd: result.sampleEnd, overallObservations: result.observations,
      rankInterval: calculated.rankInterval ? [calculated.rankInterval.lower, calculated.rankInterval.upper] : null,
      reason: calculated.diagnostics.gate === 'aligned-input'
        ? 'Verified historical inputs are incomplete for this peer group.' : calculated.reason,
      provenance: { inputHash, groupId: group.id, sourceHashes: [...new Set(inputs.sourceHashes)].sort() } };
  });
  const snapshot = {
    schemaVersion: 1, source: 'independent-quad-research', historicalOnly: true, available: true, verified: true,
    cutoff: inputs.cutoff, generatedAt: inputs.generatedAt, methodology: METHODOLOGY, groups: GROUPS,
    inputHash, sourceHashes: [...new Set(inputs.sourceHashes)].sort(),
    interpretation: 'Independent retrospective historical comparison. GDP advance releases occur after the measured quarter. Lower ranks indicate higher arithmetic mean quarterly ETF total return within the defined peers. These are not Hedgeye selected-list ranks or forecasts.',
    validation: inputs.validation || {},
    unclassifiedQuarters: (inputs.macro?.rows || []).filter(row => row.quad === null || row.latestQuad === null)
      .map(row => ({ quarter: row.quarter, quad: row.quad, latestQuad: row.latestQuad,
        reason: row.reason || null, latestReason: row.latestReason || null })),
    groupResults, cells,
  };
  snapshot.version = editionIdentity(snapshot);
  return snapshot;
}

function auditMarkdown(snapshot) {
  const text = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const counts = snapshot.cells.reduce((result, cell) => {
    result[cell.classification] = (result[cell.classification] || 0) + 1;
    return result;
  }, {});
  const lines = [
    '# Independent Quad rank audit', '',
    `Calculated ${snapshot.generatedAt}; completed-quarter cutoff **${snapshot.cutoff}**.`, '',
    `Edition: \`${snapshot.version}\`. Input manifest: \`${snapshot.inputHash}\`.`, '',
    `All **141 published cells are preserved**. Audited **39 gaps**: ${['filled', 'insufficient history', 'unstable', 'undefined'].map(category => `**${counts[category] || 0} ${category}**`).join(', ')}.`, '',
    '“Insufficient history” includes unavailable or unvalidated source observations; the evidence below distinguishes these from a short calendar sample. No missing peer is removed. A star denotes an independent retrospective historical comparison, not a Hedgeye rank or a forecast.', '',
    '| Factor | Quad | Proxy | Decision | Display | Observations / episodes | Evidence |',
    '|---|---|---|---|---|---|---|',
    ...[...snapshot.cells].sort((a, b) => a.label.localeCompare(b.label) || a.quad - b.quad).map(cell => {
      const interval = cell.rankInterval?.join('–');
      const evidence = cell.status === 'supported'
        ? `Mean ${(cell.meanReturn * 100).toFixed(4)}%; rank ${cell.rank} of ${cell.peerCount}; interval envelope ${interval}; all three block lengths and sensitivities pass.`
        : cell.reason;
      return `| ${text(cell.label)} | Q${cell.quad} | ${cell.benchmark?.symbol || '—'} | ${cell.classification} | ${cell.rank == null ? '—' : `${cell.rank}*`} | ${cell.observations} / ${cell.episodes} | ${text(evidence)} |`;
    }), '', '## Evidence trail', '',
    'Local immutable JSON files live under `data/quad-research/` (or `QUAD_RESEARCH_DIRECTORY`). They contain no portfolio positions. The API returns per-cell diagnostics and source hashes.', '',
    `- Edition: \`editions/${snapshot.version}.json\` — all 39 decisions and every internal peer/Quad result.`,
    `- Inputs: \`inputs/${snapshot.inputHash}.json\` — exact aligned returns, vintage values, source validation and observation dates.`,
    '- Sources: `raw/<SHA256>.json`; retrieval records: `retrievals/<SHA256>.json` — request URL, provider and retrieval date. API credentials are removed from archived URLs.',
    '- Each supported cell includes 2-, 4- and 8-quarter bootstrap intervals, deterministic seeds, invalid draw counts, both macro sensitivities and every episode deletion.', '',
    '## Group coverage', '', '| Group | Fixed start | End | Common quarters | Validation issues |', '|---|---|---|---|---|',
    ...snapshot.groupResults.map(result => `| ${text(GROUPS.find(group => group.id === result.groupId).label)} | ${result.sampleStart || '—'} | ${result.sampleEnd || '—'} | ${result.observations} | ${text(result.issues.join(' ') || 'None')} |`), '',
    '## Source-validation scope', '',
    'Corporate-action reconstruction covers all 37 ETFs and checks internal consistency against the same vendor. Independent issuer reconciliation is one SHY quarterly sample, within published rounding; it does not independently verify every historical return. The return convention is Yahoo split/distribution-adjusted market prices, which is not algebraically identical to cash-reinvestment accounting.', '',
    'Each Quad has an original BEA advance-release example. Monthly CPI levels match the official BLS historical NSA table exactly and use the archived ALFRED release-date vintage; the BLS reference is a current historical table, not a separate archive of each original monthly news release.', '',
    `Unclassified calendar quarters retained: ${(snapshot.unclassifiedQuarters || []).map(row => `${row.quarter} (${text(row.reason || row.latestReason)})`).join(', ') || 'none'}.`, '',
    '## Validation record', '', '```json', JSON.stringify(snapshot.validation, null, 2), '```', '',
  ];
  return lines.join('\n');
}

async function rebuild({ store = createSnapshotStore(), loadInputs, replayInputHash, now, cutoff, beforePublish } = {}) {
  const inputs = replayInputHash ? await store.readInputs(replayInputHash)
    : await (loadInputs || require('./inputs.cjs').loadQuadResearchInputs)({
      archiveRaw: store.archiveRaw, loadCachedRaw: store.loadCachedRaw, now, cutoff,
    });
  const inputHash = await store.saveInputs(inputs);
  const snapshot = buildSnapshot(inputs, { inputHash });
  // A previous verified edition stays selected if transport or source validation
  // failed. Statistical abstentions in a successful ingestion are valid results.
  if (inputs.validation?.fatal === true || inputs.validation?.ingestionFailed === true
    || inputs.validation?.globalIngestionFailure === true
    || !independentEvidenceVerified(inputs.validation, inputs.sourceHashes)) {
    const error = new Error('Historical ingestion failed; previous verified edition preserved.');
    error.candidate = snapshot;
    throw error;
  }
  if (beforePublish) await beforePublish(snapshot, auditMarkdown(snapshot));
  const edition = await store.publish(snapshot);
  return { edition, audit: auditMarkdown(edition) };
}

module.exports = { buildSnapshot, auditMarkdown, rebuild };
