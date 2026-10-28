import { findVin, findMileage, isValidVin } from './vehicle.js';

type Input = { title: string; condition?: string; description?: string; location?: string; askingPrice?: number | null; vehicle?: Record<string, unknown> };
type Snapshot = { estimate: number; range: { low: number; high: number } | null; vehicle: string; count: number; period: string[]; observedAt: string; providerCertainty: number | null };
const words = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const SOURCE = 'https://data.vinaudit.com/docs/api/market/values';

// This is a provider estimate, not a set of invented comparable sales. Keep
// its sample count and certainty separate from individual evidence and accuracy.
export function createVehicleValuation({ fetchImpl = fetch, apiKey = () => process.env.VINAUDIT_API_KEY || '', now = Date.now, timeoutMs = 6500 } = {}) {
  const cache = new Map<string, { expires: number; snapshot: Snapshot }>();
  const pending = new Map<string, Promise<Snapshot | null>>();
  return async function valueVehicle(input: Input) {
    const v = input.vehicle || {};
    const text = `${input.title} ${input.description || ''}`;
    const vin = String(v.vin || findVin(text) || '').trim().toUpperCase();
    const mileage = v.mileage == null || v.mileage === '' ? findMileage(text) : Number(v.mileage);
    const condition = String(input.condition || 'unknown');
    const type = String(v.valuationType || 'retail');
    const zip = String(v.zip || input.location?.match(/\b\d{5}\b/)?.[0] || '');
    const titleStatus = String(v.titleStatus || 'unknown');
    const missing: string[] = [];
    if (!isValidVin(vin)) missing.push('valid VIN');
    if (mileage == null || !Number.isInteger(mileage) || mileage < 0 || mileage > 1000000) missing.push('mileage');
    if (!['new', 'like_new', 'good', 'fair', 'poor'].includes(condition)) missing.push('condition');
    if (!/^\d{5}$/.test(zip)) missing.push('ZIP');
    if (!['clean', 'salvage', 'rebuilt', 'branded'].includes(titleStatus)) missing.push('title status');
    const subject = { vin: vin || null, mileage, trim: v.trim || null, drivetrain: v.drivetrain || null, zip: zip || null, titleStatus, condition };
    const base = {
      title: input.title, category: 'vehicle', askingPrice: input.askingPrice ?? null,
      fairMarketValue: null as number | null, valuationBasis: 'unknown', confidencePercent: null,
      comparablesUsed: 0, soldComparables: 0, activeComparables: 0, compBasis: 'unknown', comparableEvidence: [],
      weakEvidence: true, engineVersion: 'vehicle-provider-1',
      verdict: 'Insufficient Data', decision: null, resale: { available: false },
      vehicleValuation: { status: 'needs_details', reason: 'missing_vehicle_details', missing, subject,
        source: 'VinAudit', sourceUrl: SOURCE, valueType: type, estimate: null as number | null,
        range: null as { low: number; high: number } | null, providerListingCount: 0,
        providerCertainty: null as number | null, observedAt: null as string | null, period: [] as string[],
        cached: false, geographicScope: 'US national; ZIP is used for separate listing comparisons, not a provider adjustment',
        privatePartyValue: null, tradeInValue: null as number | null, retailValue: null as number | null,
        guidance: 'Need more evidence. Missing data is not a bad deal. Do not issue BUY, PASS, profit, or an offer ceiling from this result.' },
    };
    const unavailable = (reason: string) => ({ ...base, vehicleValuation: { ...base.vehicleValuation, status: 'unavailable', reason } });
    if (missing.length) return base;
    if (!['retail', 'tradein'].includes(type)) return unavailable('valuation_type_not_supported');
    const key = apiKey();
    if (!key) return unavailable('provider_not_configured');
    const providerCondition = ['new', 'like_new'].includes(condition) ? 'like_new' : ['fair', 'poor'].includes(condition) ? 'not_great' : 'average';
    const damage = titleStatus === 'salvage' ? 'salvage' : ['rebuilt', 'branded'].includes(titleStatus) ? 'brand' : undefined;
    // Key-scoped caches cannot survive account/key changes; never log keys/VINs.
    const cacheKey = JSON.stringify([key, vin, mileage, type, providerCondition, damage]);
    for (const [k, entry] of cache) if (entry.expires <= now()) cache.delete(k);
    const prior = cache.get(cacheKey);
    let snapshot = prior?.snapshot || null;
    if (!snapshot) {
      let request = pending.get(cacheKey);
      if (!request) {
        if (pending.size >= 64) return unavailable('provider_busy');
        request = (async (): Promise<Snapshot | null> => {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const params = new URLSearchParams({ key, vin, mileage: String(mileage), type, condition: providerCondition, country: 'usa', period: '90', format: 'json' });
            if (damage) params.set('known_damage', damage);
            const body = await Promise.race([
              (async () => {
                // POST keeps API credentials out of request URLs/access logs.
                const response = await fetchImpl('https://marketvalue.vinaudit.com/v2/marketvalue', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal: controller.signal });
                if (!response.ok) throw new Error('provider_unavailable');
                return response.json();
              })(),
              new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('provider_timeout')); }, timeoutMs); }),
            ]);
            const estimate = body.mean;
            const period = body.period;
            const end = Array.isArray(period) && period.length === 2 ? Date.parse(period[1]) : NaN;
            const start = Array.isArray(period) && period.length === 2 ? Date.parse(period[0]) : NaN;
            if (body.success !== true || body.vin !== vin || body.type !== type || !positive(estimate)
              || !Number.isInteger(body.count) || body.count < 10 || typeof body.vehicle !== 'string' || !body.vehicle.trim()
              || !Number.isFinite(start) || !Number.isFinite(end) || start > end
              || end > now() + 86400000 || now() - end > 90 * 86400000
              || Number(body.adjustments?.mileage?.input ?? body.mileage) !== mileage
              || (providerCondition !== 'average' && body.adjustments?.condition?.input !== providerCondition)
              || (damage && body.adjustments?.known_damage?.input !== damage)) return null;
            // Some non-retail responses carry retail distribution bands. Only
            // expose a range when it surrounds the estimate for this same type.
            const p = body.prices;
            const range = positive(p?.below) && positive(p?.above) && positive(p?.average)
              && Math.abs(p.average - estimate) <= 1 && p.below <= estimate && p.above >= estimate
              ? { low: p.below, high: p.above } : null;
            const result = { estimate, range, vehicle: String(body.vehicle), count: body.count,
              period: period.map(String), observedAt: new Date(now()).toISOString(),
              providerCertainty: typeof body.certainty === 'number' && body.certainty >= 0 && body.certainty <= 100 ? body.certainty : null };
            if (cache.size >= 256) cache.delete(cache.keys().next().value!);
            cache.set(cacheKey, { snapshot: result, expires: now() + 600000 });
            return result;
          } catch { return null; }
          finally { clearTimeout(timer); }
        })();
        pending.set(cacheKey, request);
        void request.finally(() => pending.delete(cacheKey));
      }
      snapshot = await request;
    }
    if (!snapshot) return unavailable('provider_unavailable_or_evidence_invalid');
    // A matching VIN must not erase a contradictory user-supplied identity.
    const expectedYear = String(v.year || input.title.match(/\b(?:19|20)\d{2}\b/)?.[0] || '');
    const identityTokens = snapshot.vehicle.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g)?.map(words) || [];
    if ([expectedYear, v.make, v.model, v.trim].filter(Boolean).some(value => !String(value).split(/\s+/).every(token => identityTokens.includes(words(token))))) return unavailable('vehicle_identity_conflict');
    return { ...base, fairMarketValue: snapshot.estimate, valuationBasis: 'provider_estimate', verdict: 'Review Needed',
      vehicleValuation: { ...base.vehicleValuation, status: 'estimate', reason: null, missing: [],
        providerVehicle: snapshot.vehicle, estimate: snapshot.estimate, range: snapshot.range,
        providerListingCount: snapshot.count, providerCertainty: snapshot.providerCertainty,
        observedAt: snapshot.observedAt, period: snapshot.period, cached: Boolean(prior),
        retailValue: type === 'retail' ? snapshot.estimate : null, tradeInValue: type === 'tradein' ? snapshot.estimate : null,
        guidance: `Report this as a ${type === 'tradein' ? 'trade-in' : 'retail'} provider estimate, not a confirmed sale or private-party valuation. Preserve the range, date and national scope. No automatic BUY/PASS or offer ceiling: inspection, history and local same-trim evidence still require review.` } };
  };
}

export const valueVehicle = createVehicleValuation();
