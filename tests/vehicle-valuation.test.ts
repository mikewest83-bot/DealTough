import { expect, it, vi } from 'vitest';
import { createVehicleValuation } from '../src/vehicle-valuation.js';

const now = () => Date.parse('2026-10-11T00:00:00Z');
const vin = '1NXBR32E85Z505904';
const input = { title: '2005 Toyota Corolla CE', condition: 'good', askingPrice: 5000,
  vehicle: { vin, mileage: 90000, zip: '29401', titleStatus: 'clean', trim: 'CE' } };
const body = { success: true, vin, vehicle: '2005 Toyota Corolla CE', type: 'retail', mean: 5000,
  count: 25, mileage: 90000, certainty: 99, period: ['2026-09-01', '2026-10-10'],
  prices: { average: 5000, below: 4000, above: 6000 } };
const fake = (value = body) => vi.fn(async () => Response.json(value)) as unknown as typeof fetch;

it('does not turn missing details or missing provider access into a negative deal verdict', async () => {
  const fetchImpl = fake();
  const lookup = createVehicleValuation({ fetchImpl, apiKey: () => '', now });
  const missing = await lookup({ title: '2019 Toyota Camry LE' });
  expect(missing.fairMarketValue).toBeNull();
  expect(missing.vehicleValuation.missing).toEqual(['valid VIN', 'mileage', 'condition', 'ZIP', 'title status']);
  expect(missing.verdict).toBe('Insufficient Data');
  expect((await lookup(input)).vehicleValuation.reason).toBe('provider_not_configured');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('sends VIN and mileage without asking-price anchoring and preserves provider value and provenance', async () => {
  const calls: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    expect(String(url)).not.toContain('secret');
    expect(init?.method).toBe('POST');
    calls.push(new URLSearchParams(String(init?.body)));
    return Response.json(body);
  };
  const lookup = createVehicleValuation({ fetchImpl, apiKey: () => 'secret', now });
  const result = await lookup(input);
  expect(calls[0].get('vin')).toBe(vin);
  expect(calls[0].get('mileage')).toBe('90000');
  expect(calls[0].get('condition')).toBe('average');
  expect(calls[0].has('askingPrice')).toBe(false);
  expect(result.fairMarketValue).toBe(5000);
  expect(result.vehicleValuation.range).toEqual({ low: 4000, high: 6000 });
  expect(result.vehicleValuation.providerListingCount).toBe(25);
  expect(result.soldComparables).toBe(0);
  expect(result.comparablesUsed).toBe(0);
  expect(result.confidencePercent).toBeNull();
  expect(result.decision).toBeNull();
  const repeat = await lookup({ ...input, askingPrice: 90000 });
  expect(repeat.fairMarketValue).toBe(5000);
  expect(repeat.vehicleValuation.cached).toBe(true);
  expect(calls).toHaveLength(1);
});

it.each([
  { vin: '11111111111111111' }, { count: 2 }, { mean: -1 }, { type: 'tradein' },
  { mileage: 190000 }, { period: ['2025-01-01', '2025-02-01'] }, { success: false },
])('fails closed on mismatched or inadequate provider evidence: %j', async patch => {
  const lookup = createVehicleValuation({ fetchImpl: fake({ ...body, ...patch }), apiKey: () => 'test', now });
  expect((await lookup(input)).fairMarketValue).toBeNull();
});

it('rejects a contradictory trim even for a matching VIN', async () => {
  const lookup = createVehicleValuation({ fetchImpl: fake(), apiKey: () => 'test', now });
  const result = await lookup({ ...input, vehicle: { ...input.vehicle, trim: 'LE' } });
  expect(result.vehicleValuation.reason).toBe('vehicle_identity_conflict');
});

it('does not label retail bands as trade-in ranges or invent private-party prices', async () => {
  const lookup = createVehicleValuation({ fetchImpl: fake({ ...body, type: 'tradein', mean: 3000 }), apiKey: () => 'test', now });
  const result = await lookup({ ...input, vehicle: { ...input.vehicle, valuationType: 'tradein' } });
  expect(result.fairMarketValue).toBe(3000);
  expect(result.vehicleValuation.range).toBeNull();
  expect(result.vehicleValuation.privatePartyValue).toBeNull();
  expect((await lookup({ ...input, vehicle: { ...input.vehicle, valuationType: 'private_party' } })).vehicleValuation.reason).toBe('valuation_type_not_supported');
});

it('bounds stalled requests even when a provider ignores cancellation', async () => {
  const lookup = createVehicleValuation({ fetchImpl: async () => new Promise<Response>(() => {}), apiKey: () => 'test', now, timeoutMs: 20 });
  expect((await lookup(input)).vehicleValuation.status).toBe('unavailable');
});
