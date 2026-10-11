import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fetchComparables, clearComparableCache, mapBrowseResultsToComparables } from '../src/ebay.js';

const title = 'DeWalt DWE7491RS table saw with stand';
const row = (id: number, price = 400) => ({ itemId: `v1|${id}|0`, itemWebUrl: `https://www.ebay.com/itm/${id}`, title, price: { value: String(price), currency: 'USD' }, condition: 'Used' });
beforeEach(() => { process.env.EBAY_CLIENT_ID = 'test'; process.env.EBAY_CLIENT_SECRET = 'test'; delete process.env.EBAY_MARKETPLACE_INSIGHTS; clearComparableCache(); });
afterEach(() => vi.unstubAllGlobals());

it('retains source identity, price basis and condition for the exact priced rows', () => {
  const listing = row(123456789001);
  const [comp] = mapBrowseResultsToComparables({ itemSummaries: [listing] }, title);
  expect(comp).toMatchObject({ title, sourceUrl: listing.itemWebUrl, sourceId: listing.itemId, price: 400, sold: false, condition: 'good' });
});

it('rejects foreign-currency prices and deduplicates the same source listing', () => {
  const listing = row(123456789001);
  const rows = [listing, listing, { ...row(123456789002), price: { value: '450', currency: 'EUR' } }];
  expect(mapBrowseResultsToComparables({ itemSummaries: rows }, title)).toHaveLength(1);
});

it('continues after a parts-heavy page and keeps earlier valid listings', async () => {
  let searches = 0;
  vi.stubGlobal('fetch', async (input: string | URL) => {
    if (String(input).includes('oauth2/token')) return Response.json({ access_token: 'test', expires_in: 7200 });
    searches++;
    const rows = searches === 1
      ? [row(123456789001), ...Array.from({ length: 12 }, () => ({ ...row(123456789099, 20), title: 'Replacement fence for DeWalt DWE7491RS table saw' }))]
      : [row(123456789002, 420), row(123456789003, 440), row(123456789004, 460), row(123456789005, 480)];
    return Response.json({ itemSummaries: rows });
  });
  const comps = await fetchComparables({ title, category: 'tools' });
  expect(searches).toBe(2);
  expect(comps.map(c => c.price).sort()).toEqual([400, 420, 440, 460, 480]);
});

it('retains the original model requirement when a recovery query is broader', async () => {
  vi.stubGlobal('fetch', async (input: string | URL) => String(input).includes('oauth2/token')
    ? Response.json({ access_token: 'test', expires_in: 7200 })
    : Response.json({ itemSummaries: [{ ...row(123456789001), title: 'DeWalt DWE7485 table saw with stand' }] }));
  const comps = await fetchComparables({ title: 'DeWalt table saw', referenceTitle: title, category: 'tools' });
  expect(comps).toEqual([]);
});

it('recovery collects a thin first sample without relaxing the original identity', async () => {
  const { fetchComparablesWithRecovery } = await import('../src/market-value-route.js');
  const search = vi.fn(async (args) => args.category
    ? [{ source: 'ebay_active', sourceId: '1', price: 400, title }]
    : Array.from({ length: 5 }, (_, i) => ({ source: 'ebay_active', sourceId: String(i + 1), price: 400 + i * 20, title })));
  const result = await fetchComparablesWithRecovery({ title, category: 'tools' }, search);
  expect(result.comparables).toHaveLength(5);
  expect(result.attempts).toBe(2);
  expect(search.mock.calls.every(([args]) => args.referenceTitle === title)).toBe(true);
});

it('bounds recovery and returns earlier evidence when the next provider stalls', async () => {
  const { fetchComparablesWithRecovery } = await import('../src/market-value-route.js');
  let signal: AbortSignal | undefined;
  const search = vi.fn(async (args) => {
    signal = args.signal;
    if (args.category) return [{ source: 'ebay_active', sourceId: '1', price: 400, title }];
    return new Promise<never>(() => {});
  });
  const result = await fetchComparablesWithRecovery({ title, category: 'tools' }, search, 25);
  expect(result.comparables).toHaveLength(1);
  expect(result.partial).toBe(true);
  expect(signal?.aborted).toBe(true);
});

it('shared voltage or drivetrain descriptors cannot substitute for the actual model', () => {
  for (const [reference, candidate] of [
    ['DeWalt DWE7491RS 10in table saw', 'DeWalt DWE7485 10in table saw'],
    ['Milwaukee M18 2767 impact wrench', 'Milwaukee M18 2967 impact wrench'],
    ['2019 Ford F150 4x4 truck', '2019 Ford F250 4x4 truck'],
  ]) {
    expect(mapBrowseResultsToComparables({ itemSummaries: [{ ...row(123456789001), title: candidate }] }, reference)).toEqual([]);
  }
  expect(mapBrowseResultsToComparables({ itemSummaries: [row(123456789001)] }, 'DeWalt DWE7491RS 10in table saw')).toHaveLength(1);
});
