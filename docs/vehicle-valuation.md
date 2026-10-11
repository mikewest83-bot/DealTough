# VIN valuation activation and validation

The Mike-facing market-value route uses VIN, mileage, stated condition and title status. ZIP is required for separate listing comparisons; the documented VinAudit API returns US national estimates, not a ZIP adjustment. Asking price is never an input to the provider estimate. A clean title is user-supplied, not verified vehicle history.

Activate a VinAudit Market Values API account and configure `VINAUDIT_API_KEY` on the DealTough service through the environment secret manager. Do not put credentials in source, chat, or URLs. Provider contract: https://data.vinaudit.com/docs/api/market/values . This implementation has fixture coverage; a real authorized provider response must still be verified after activation.

The endpoint uses a 6.5-second provider budget and a ten-minute bounded cache. It rejects invalid VINs, missing inputs, stale or mismatched responses, insufficient provider samples, and unacknowledged condition/title adjustments. Missing evidence is not a negative deal verdict. An accepted result is a labeled retail or trade-in estimate for review. Private-party values, completed comparable sales, profit and offer ceilings are not manufactured. Provider certainty is not measured valuation accuracy.

## Outcome evaluation

Run `npx tsx scripts/evaluate-vehicles.ts reviewed-outcomes.json` with an array of reviewed records. Each record needs a unique `id`, `valueType` and matching `saleType` (`retail` or `tradein`), `estimatedAt`, later `soldAt`, `sourceRef`, `ownerReviewed: true`, `estimate` (number or null for an abstention), and positive `soldPrice`. An optional `range` has `low` and `high`.

Record predictions before the sale and retain evidence for the actual transaction, including comparable fee/tax treatment. Never replace a recorded estimate using hindsight. Use real reviewed outcomes covering age, mileage, condition and geography; synthetic test records are not accuracy evidence. The report shows errors, coverage and abstentions separately and never declares accuracy established from a small sample. Review error by segment before expanding automatic recommendations.
