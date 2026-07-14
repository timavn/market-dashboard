import hermesRules from './hermesRules.json';

export default hermesRules;

export function classifyVixBucket(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return (hermesRules.volatility?.vixBuckets || []).find((bucket) => {
    const max = bucket.max == null ? Infinity : Number(bucket.max);
    return numeric >= Number(bucket.min) && numeric <= max;
  }) || null;
}

export function getExposureCapsForBucket(bucketKey) {
  return hermesRules.exposureCaps?.[bucketKey] || null;
}
