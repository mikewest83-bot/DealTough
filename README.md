# DealTough

**Mission:** Help users avoid bad purchases, understand true value, save money, and negotiate confidently.

Paste a marketplace listing (text + photos), get back a 100-point Deal Score with price
targets, risk flags, and a copy-ready negotiation message. Live at
`https://dealtough-production.up.railway.app` (web UI at `/`).

## Architecture

| Layer | What it does | Credential |
|---|---|---|
| Web UI (`public/index.html`) | Paste listing → results + DealVault history | API key (browser-stored) |
| Extraction (`src/extract.ts`) | Claude reads listing text/photos → structured fields + risk signals | `ANTHROPIC_API_KEY` |
| Comparables (`src/ebay.ts`) | eBay Browse API active-listing prices (labeled `ebay_active`, not sold comps) | `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` |
| Engine (`src/engine.ts`) | Deterministic DTE-1.0 scoring — pure, no I/O | none |
| DealVault (`prisma/`, `src/db.ts`) | Persists every analysis to Postgres | `DATABASE_URL` |

Every capability degrades independently when its credential is missing — the server
always boots, and unaffected routes keep working.

## API

All routes are JSON and open — no API key required.

```http
GET  /health                       → { ok, engineVersion }
POST /api/v1/deals/analyze         → DealRecommendation (caller supplies full DealInput)
POST /api/v1/deals/from-listing    → full pipeline: { rawText, photos?, categoryOverride? }
GET  /api/v1/deals                 → recent analyses (limit ≤ 100, offset)
GET  /api/v1/deals/:id             → one saved analysis
```

`from-listing` is rate-limited (6/min per IP) since it spends Anthropic tokens.
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
ANTHROPIC_API_KEY=...    # listing extraction (console.anthropic.com)
EBAY_CLIENT_ID=...       # comparables (developer.ebay.com production keyset)
EBAY_CLIENT_SECRET=...
DATABASE_URL=...         # DealVault (Postgres)
```

## Deploy (Railway)

`railway.json` drives the build (`npm install --include=dev && npm run build`) and start
(`npm start`). Postgres runs as a Railway plugin; `DATABASE_URL` is a reference variable
on the app service. Migrations run via `prisma migrate deploy` through a **temporary**
TCP proxy on the Postgres service — always delete the proxy immediately after.

## Honest limitations

- eBay comparables are **active listings**, not sold prices — fair-market-value estimates
  skew slightly high. eBay's sold-comps API (Marketplace Insights) is restricted to
  approved partners.
- Category → eBay search mapping is keyword-based, best-effort; generic titles pull
  noisy comps.
- No auth, no user accounts. The only cost guard on `from-listing` (which spends
  Anthropic tokens once `ANTHROPIC_API_KEY` is set) is a 6/min-per-IP in-memory rate
  limit — a determined abuser could still run up a bill over time. Fine for early,
  low-traffic use; revisit before wide distribution.
