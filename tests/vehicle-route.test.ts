import { it, expect, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';

it('vehicle HTTP requests preserve service authentication and work without eBay or valuation credentials', async () => {
  vi.stubEnv('MARKET_VALUE_TOKEN', 'disposable-contract-test');
  vi.stubEnv('VINAUDIT_API_KEY', '');
  vi.stubEnv('EBAY_CLIENT_ID', '');
  vi.stubEnv('EBAY_CLIENT_SECRET', '');
  const { installMarketValueRoute } = await import('../src/market-value-route.js');
  const app = express(); app.use(express.json()); installMarketValueRoute(app);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/api/v1/market-value`;
    const body = { category: 'vehicle', title: '2005 Toyota Corolla CE', condition: 'good', vehicle: { vin: '1NXBR32E85Z505904', mileage: 90000, zip: '29401', titleStatus: 'clean' } };
    const headers = { 'content-type': 'application/json' };
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(401);
    const response = await fetch(url, { method: 'POST', headers: { ...headers, 'x-dealtough-token': 'disposable-contract-test' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fairMarketValue: null, verdict: 'Insufficient Data', vehicleValuation: { reason: 'provider_not_configured' } });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); }
});
