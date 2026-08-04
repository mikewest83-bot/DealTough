# DealTough

**Mission:** Help users avoid bad purchases, understand true value, save money, and negotiate confidently.

Paste a marketplace listing (text + photos), get back a 100-point Deal Score with price
targets, risk flags, and a copy-ready negotiation message. Live at
`https://dealtough-production.up.railway.app` (web UI at `/`).

## Architecture

| Layer | What it does | Credential |
|---|---|---|
| Web UI (`public/index.html`) | Paste listing → results, DealVault history, share links | session cookie |
| Extraction (`src/extract.ts`) | Claude reads listing text/photos → structured fields + risk signals | `ANTHROPIC_API_KEY` |
| Comparables (`src/ebay.ts`) | eBay comparables — sold prices when available, otherwise active listings | `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` |
| Engine (`src/engine.ts`) | Deterministic DTE-1.0 scoring — pure, no I/O | none |
| DealVault (`prisma/`, `src/db.ts`) | Persists every analysis to Postgres | `DATABASE_URL` |
| Accounts & billing (`src/auth.ts`, `src/billing.ts`) | Sign-in, free-tier allowance, credit packs | `JWT_SECRET`, `STRIPE_SECRET_KEY` |
| Logging (`src/log.ts`) | One JSON object per line — greppable in Railway logs | `LOG_LEVEL` (optional) |

`src/app.ts` builds the Express app; `src/server.ts` is only the process entry point, so
tests mount the app on an ephemeral port instead of racing for the production one.

### Comparable quality

Comparables are scored, not just averaged. Each eBay result gets a title-similarity
weight, obvious accessory listings ("for Ford F-150") are dropped, price outliers are
rejected by median-absolute-deviation, and each result carries its own condition label so
comparables matching the listing's condition count for more. Because the engine already
applies a category condition discount, that discount is scaled back when the comparables
are themselves labeled — otherwise the same wear would be charged twice.

Results are cached in-process for 6 hours, so repeat analyses of the same item do not
re-hit eBay.

Every capability degrades independently when its credential is missing — the server
always boots, and unaffected routes keep working.

## API

All routes are JSON. Authenticated routes read the `session` cookie.

```http
GET    /health                            → { ok, engineVersion }
POST   /api/auth/register | login | logout
GET    /api/auth/me                       → account summary
GET    /api/billing/packs                 → credit packs
POST   /api/billing/subscribe | checkout  🔒 → Stripe checkout URL
POST   /api/v1/deals/analyze              → DealRecommendation (caller supplies full DealInput)
POST   /api/v1/deals/from-listing         🔒 full pipeline: { rawText, photos?, categoryOverride? }
GET    /api/v1/deals                      🔒 recent analyses (limit ≤ 100, offset)
GET    /api/v1/deals/:id                  🔒 one saved analysis
POST   /api/v1/deals/:id/share            🔒 → { url } — mints or reuses a share id
DELETE /api/v1/deals/:id/share            🔒 revokes the share link
GET    /api/v1/public/deals/:shareId      → shared report (no auth)
GET    /d/:shareId                        → shared report, rendered
```

Deal routes are ownership-scoped: another account's deal returns 404, not 403. A shared
report exposes only the title, category, asking price, condition, date, and
recommendation — never the raw listing text, which can carry the seller's contact details.

`from-listing` is rate-limited 6/min per IP since it spends Anthropic tokens; the public
share route gets its own 60/min bucket.
Photos are base64 (`{ base64, mediaType }`), ≤ 4 MB each, jpeg/png/gif/webp.

## Score weights

| Component | Maximum |
|---|---:|
| Value | 35 |
| Risk | 20 |
| True Cost | 15 |
| Negotiation | 10 |
| Market | 10 |
| Confidence | 10 |

## Verdict bands

| Score | Verdict |
|---:|---|
| 95–100 | Exceptional Deal |
| 90–94 | Excellent Deal |
| 80–89 | Great Buy |
| 70–79 | Good Deal |
| 60–69 | Fair Deal |
| 40–59 | High Risk |
| 0–39 | Walk Away |

### Protective rule

A critical risk caps the score at 39 and forces **Walk Away**.
A high-risk result is capped at 59. Cheap pricing cannot override serious danger.

## Run it locally

```bash
npm install
npm test        # offline — no credentials needed
npm run build   # prisma generate + tsc
npm start       # serves UI + API on :4000
```

Environment (all optional locally; the affected feature just switches off):

```bash
ANTHROPIC_API_KEY=...        # listing extraction (console.anthropic.com)
EBAY_CLIENT_ID=...           # comparables (developer.ebay.com production keyset)
EBAY_CLIENT_SECRET=...
EBAY_MARKETPLACE_INSIGHTS=1  # opt in to sold prices — only if eBay approved the scope
DATABASE_URL=...             # DealVault (Postgres)
JWT_SECRET=...               # sessions; without it the auth routes return 503
STRIPE_SECRET_KEY=...        # billing
LOG_LEVEL=debug|info|warn|error   # defaults: debug locally, info in production
```

`EBAY_MARKETPLACE_INSIGHTS` is opt-in on purpose. The sold-price scope
(`buy.marketplace.insights`) is granted per application on request, and asking for a scope
you have not been approved for fails the entire token call — which would take active
comparables down with it. Leave it unset until eBay approves the application.

## Deploy (Railway)

`railway.json` drives the build (`npm install --include=dev && npm run build`) and start
(`npm start`). Postgres runs as a Railway plugin; `DATABASE_URL` is a reference variable
on the app service. Migrations run via `prisma migrate deploy` through a **temporary**
TCP proxy on the Postgres service — always delete the proxy immediately after.

## Honest limitations

- Until eBay approves the Marketplace Insights scope, comparables are **active listings**
  — asking prices, not sold prices — so fair-market-value estimates skew slightly high.
  The response labels which it used (`comparablesSource`).
- Category → eBay search mapping is keyword-based, best-effort; generic titles pull
  noisy comps. Relevance filtering discards the worst of them, which correctly drags the
  reported confidence down rather than hiding the problem.
- The comparable cache and the rate limiter are both in-process. They do their job on a
  single Railway instance; scaling out horizontally would need a shared store.
- A share link is an unguessable 72-bit id, not an access check. Anyone holding the URL
  can read that report until it is revoked.
