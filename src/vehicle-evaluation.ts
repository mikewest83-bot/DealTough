export type VehicleOutcome = {
  id: string; valueType: 'retail' | 'tradein'; saleType: 'retail' | 'tradein';
  estimatedAt: string; soldAt: string; sourceRef: string; ownerReviewed: boolean;
  estimate: number | null; soldPrice: number; range?: { low: number; high: number };
};
// Evaluate saved predictions, never estimates generated after learning the sale.
// Provenance is owner-reviewed documentation, not a claim of API verification.
export function evaluateVehicleOutcomes(rows: VehicleOutcome[]) {
  const ids = new Set<string>();
  for (const r of rows) {
    if (!r.id || ids.has(r.id) || r.ownerReviewed !== true || !r.sourceRef?.trim()
      || !['retail', 'tradein'].includes(r.valueType) || r.valueType !== r.saleType
      || !Number.isFinite(r.soldPrice) || r.soldPrice <= 0
      || !Number.isFinite(Date.parse(r.estimatedAt)) || !Number.isFinite(Date.parse(r.soldAt))
      || Date.parse(r.estimatedAt) >= Date.parse(r.soldAt)
      || (r.estimate !== null && (!Number.isFinite(r.estimate) || r.estimate <= 0))
      || (r.range && (!Number.isFinite(r.range.low) || !Number.isFinite(r.range.high) || r.range.low <= 0 || r.range.high < r.range.low))) throw new Error('invalid_or_unreviewed_outcome');
    ids.add(r.id);
  }
  const priced = rows.filter(r => r.estimate !== null);
  const errors = priced.map(r => r.estimate! - r.soldPrice);
  const percentErrors = priced.map(r => Math.abs(r.estimate! - r.soldPrice) / r.soldPrice * 100).sort((a,b) => a-b);
  const ranged = priced.filter(r => r.range);
  const mean = (nums: number[]) => nums.length ? nums.reduce((s,n) => s+n, 0) / nums.length : null;
  const mid = Math.floor(percentErrors.length / 2);
  return { documentedOutcomes: rows.length, priced: priced.length, abstained: rows.length - priced.length,
    estimateCoverage: rows.length ? priced.length / rows.length : null,
    meanAbsoluteError: mean(errors.map(Math.abs)), meanSignedError: mean(errors),
    medianAbsolutePercentError: percentErrors.length ? (percentErrors[(percentErrors.length-1) >> 1] + percentErrors[mid]) / 2 : null,
    rangeCoverage: ranged.length ? ranged.filter(r => r.soldPrice >= r.range!.low && r.soldPrice <= r.range!.high).length / ranged.length : null,
    provenance: 'owner-reviewed sale documentation; not independent transaction verification',
    accuracyEstablished: false,
    note: 'A descriptive benchmark, not proof of accuracy. Report sample size, coverage and market segment. Synthetic test fixtures must never be reported as sale outcomes.' };
}
