import { expect, it } from 'vitest';
import { evaluateVehicleOutcomes, type VehicleOutcome } from '../src/vehicle-evaluation.js';
const fixture: VehicleOutcome = { id: 'synthetic-test-only', valueType: 'retail', saleType: 'retail', estimatedAt: '2026-01-01', soldAt: '2026-01-02', sourceRef: 'synthetic fixture — not a real sale', ownerReviewed: true, estimate: 11000, soldPrice: 10000 };
it('measures error and abstentions separately instead of hiding missing valuations', () => {
  const r = evaluateVehicleOutcomes([fixture, { ...fixture, id: 'second-synthetic', estimate: null }]);
  expect(r.meanAbsoluteError).toBe(1000);
  expect(r.medianAbsolutePercentError).toBe(10);
  expect(r.estimateCoverage).toBe(.5);
  expect(r.accuracyEstablished).toBe(false);
});
it('rejects after-the-fact estimates, duplicate outcomes and mismatched value types', () => {
  expect(() => evaluateVehicleOutcomes([{ ...fixture, estimatedAt: '2026-01-03' }])).toThrow();
  expect(() => evaluateVehicleOutcomes([fixture, fixture])).toThrow();
  expect(() => evaluateVehicleOutcomes([{ ...fixture, saleType: 'tradein' }])).toThrow();
  expect(() => evaluateVehicleOutcomes([{ ...fixture, ownerReviewed: 'false' as unknown as boolean }])).toThrow();
  expect(evaluateVehicleOutcomes([]).meanAbsoluteError).toBeNull();
});
