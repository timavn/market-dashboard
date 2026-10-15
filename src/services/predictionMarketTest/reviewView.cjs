const { isDeepStrictEqual } = require('node:util');

// Reviews retain complete native ladders and their provenance, but do not use
// interactive chart series, depth arrays or duplicate representations of a book.
function reviewContracts(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    ...(Array.isArray(value.lines) ? { lines: value.lines.map(line => {
      if (!line?.nativeOrderbook || typeof line.nativeOrderbook !== 'object') return line;
      const { yesBids, noBids, ...metadata } = line.nativeOrderbook;
      return { ...line, nativeOrderbook: metadata };
    }) } : {}),
  };
}

function reviewReference(value) {
  if (!value || typeof value !== 'object') return value;
  const { chart, chartReferences, exactReference, proxyReference, ...evidence } = value;
  return {
    ...evidence,
    ...(chartReferences && typeof chartReferences === 'object' ? {
      chartReferences: Object.fromEntries(Object.entries(chartReferences).map(([key, reference]) => [key, reviewReference(reference)])),
    } : {}),
    ...(exactReference ? { exactReference: reviewReference(exactReference) } : {}),
    ...(proxyReference ? { proxyReference: reviewReference(proxyReference) } : {}),
  };
}

function omitDuplicateLines(value, candidates) {
  if (!Array.isArray(value?.lines)) return value;
  const duplicate = candidates.find(([, candidate]) => Array.isArray(candidate?.lines)
    && isDeepStrictEqual(value.lines, candidate.lines));
  if (!duplicate) return value;
  const { lines, ...metadata } = value;
  return { ...metadata, linesFrom: duplicate[0] };
}

function createReviewView(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { chart, generationOptions, ...evidence } = snapshot;
  const result = { ...evidence, responseView: 'review' };
  const canonical = [['displayContracts', snapshot.displayContracts]];
  for (const [id, venue] of Object.entries(snapshot.venues || {})) {
    canonical.push([`venues.${id}.catalog`, venue?.catalog], [`venues.${id}.book`, venue?.book]);
  }
  if (snapshot.displayContracts) result.displayContracts = reviewContracts(snapshot.displayContracts);
  for (const key of ['contracts', 'executionContracts', 'selectedGeneration']) {
    if (snapshot[key]) result[key] = reviewContracts(omitDuplicateLines(snapshot[key], canonical));
  }
  for (const key of ['displaySelection', 'autoSelection']) {
    if (!snapshot[key]?.contracts) continue;
    const { contracts, ...selection } = snapshot[key];
    // The report normalizer already falls back to displayContracts. Omit only
    // exact duplicates, so an independent selection or failure remains intact.
    result[key] = isDeepStrictEqual(contracts, snapshot.displayContracts)
      ? selection : { ...selection, contracts: reviewContracts(contracts) };
  }
  if (snapshot.chartReferences) result.chartReferences = Object.fromEntries(
    Object.entries(snapshot.chartReferences).map(([key, reference]) => [key, reviewReference(reference)]),
  );
  for (const key of ['resolverReference', 'perpetualReference']) {
    if (snapshot[key]) result[key] = reviewReference(snapshot[key]);
  }
  if (snapshot.venues) result.venues = Object.fromEntries(Object.entries(snapshot.venues).map(([key, venue]) => {
    if (!venue || typeof venue !== 'object') return [key, venue];
    const { generations, reference, ...native } = venue;
    const projected = { ...native };
    for (const field of ['catalog', 'book']) {
      if (venue[field]) projected[field] = reviewContracts(venue[field]);
    }
    if (venue.contracts) projected.contracts = reviewContracts(omitDuplicateLines(venue.contracts, canonical));
    if (reference) projected.reference = reviewReference(reference);
    return [key, projected];
  }));
  return result;
}

module.exports = { createReviewView };
