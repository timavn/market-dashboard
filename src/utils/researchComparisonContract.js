export function isExplicitlySafeResearchComparison(snapshot) {
  const availability = snapshot?.dataAvailability;
  if (!snapshot || !availability) return false;
  if (
    snapshot.current !== true
    || snapshot.comparisonSafe !== true
    || snapshot.referenceOnly !== false
    || availability.current !== true
    || availability.comparisonSafe !== true
    || availability.referenceOnly !== false
    || availability.canonicalSourceVerified !== true
  ) {
    return false;
  }
  if (
    snapshot.canonicalSourceVerified === false
    || snapshot.meta?.canonicalSourceVerified === false
  ) {
    return false;
  }
  return true;
}
