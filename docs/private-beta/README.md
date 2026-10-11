# DealTough Private Beta

This package provides the operational reference for invited private-beta users of DealTough. It is documentation only: it does not alter application code, runtime configuration, credentials, or deployment behavior.

## Intended use

DealTough evaluates a proposed purchase against comparable-market data and produces a structured recommendation. Use it as decision support rather than a guarantee of resale price, availability, fees, condition, or profit. Verify all material assumptions before purchasing.

## Before you begin

- Use Node.js 20 or the version specified by `.nvmrc`.
- Install dependencies with `npm ci`.
- Copy `.env.example` if your local setup provides one, then supply only the credentials required by the enabled integrations. Never commit `.env` files, tokens, or marketplace credentials.
- Confirm that the data sources and marketplaces relevant to your test are available in your environment.

## Quick start

```bash
npm ci
npm run build
npx tsx examples/run-example.ts
```

For API-style input, validate payloads against `deal-input.schema.json` before submitting them to the application.

## Beta workflow

1. Start with a real, specific item and record its asking price, condition, shipping, taxes, expected selling channel, and any platform fees.
2. Run the analysis using conservative assumptions. Treat sparse or weak comparable data as uncertainty, not confirmation.
3. Review the recommendation, evidence quality, assumptions, and downside before acting.
4. Independently verify the listing, item condition, restrictions, shipping cost, and all marketplace policies.
5. Record the outcome in the feedback template so the product can be improved.

## Guardrails

- Do not enter secrets, payment data, or sensitive personal information in sample inputs or feedback.
- Do not rely on a recommendation as financial, tax, legal, authentication, or appraisal advice.
- A favorable result is not a commitment that an item will sell at a given price or within a given period.
- Stop and report unexpected output, missing evidence, errors, or results that conflict with the underlying listing.

## Support and feedback

File reproducible issues with the exact input shape (redacted), expected behavior, observed behavior, timestamps, and relevant logs with secrets removed. Use `docs/private-beta/feedback-template.md` for structured product feedback.

## Package contents

- `docs/private-beta/README.md` — onboarding, workflow, and safety guidance
- `docs/private-beta/feedback-template.md` — consistent tester feedback capture
- `docs/private-beta/release-checklist.md` — pre-invite and launch-readiness checklist
- `docs/private-beta/known-limitations.md` — known constraints and escalation guidance
