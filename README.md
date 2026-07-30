# DealTough Intelligence Engine — Phase 1

**Mission:** Help users avoid bad purchases, understand true value, save money, and negotiate confidently.

This package contains the first working implementation of the DealTough decision engine.

## What is included

- 100-point Deal Score
- Category-aware market valuation
- True-cost calculation
- Protective risk overrides
- Negotiation leverage scoring
- Market-demand scoring
- Confidence scoring
- Opening offer, target price, and walk-away price
- Seller questions
- Personalized negotiation message
- Explainable score breakdown
- Unit tests
- Example REST endpoint

## Official score weights

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

## Run it

```bash
npm install
npm test
npm run dev
```

## Integration

Import the engine into an existing TypeScript app:

```ts
import { analyzeDeal } from "@dealtough/intelligence-engine";

const report = analyzeDeal(input);
```

Or copy the endpoint pattern in `src/api-example.ts`:

```http
POST /api/v1/deals/analyze
Content-Type: application/json
```

## Important production note

DTE-1.0 is deterministic and explainable. It expects the app's data-collection layer to supply comparable prices, detected risks, listing completeness, hidden costs, and market indicators. The next implementation step is connecting live listing extraction, comparable-data providers, image analysis, authentication, and persistent DealVault storage.
