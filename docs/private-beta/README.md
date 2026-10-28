# DealTough Tester Guide

DealTough is live at **https://dealtoughai.com** and open to the public. Testers use
that same live site — there is nothing to install. This package is documentation only:
it does not change application code, configuration, credentials, or deployment.

## How tester access works

- The owner adds a tester's email address to the `TESTER_EMAILS` variable on the
  Railway `dealtough` service (comma or space separated). It is read on every request,
  so adding or removing someone takes effect without a redeploy.
- The tester creates an account at https://dealtoughai.com with **exactly that email**.
  Matching is case-insensitive; any other address is a normal free account.
- A tester gets the Plus monthly analysis allowance without paying
  (`TESTER_MONTHLY_ALLOWANCE` if set, otherwise the Plus allowance). It is a ceiling,
  not unlimited, because every analysis spends shared eBay and Anthropic quota.
- A tester who also subscribes keeps whichever allowance is larger.

## What to test

The analyzer has three tabs:

| Tab | What it does | Uses an analysis? |
|---|---|---|
| **Paste Listing** | Paste a listing's text (and up to 4 photos). DealTough reads it, pulls eBay comparables, and returns a 100-point Deal Score, price targets, risk flags, and a negotiation message. | Yes |
| **Manual Entry** | Enter an asking price and your own market-value estimate to score the numbers. | No — free and unlimited |
| **Sell Something** | Upload photos of an item you own and get a ready-to-post title, description, and price plan, plus a reply helper for buyer messages. | Yes |

For vehicles, include the **VIN and mileage** in the listing or notes. A VIN lets
DealTough decode the exact year, make, model, and trim, which makes comparables much
more accurate.

## Suggested workflow

1. Use a real, specific item. Note its asking price, condition, and anything you know
   about its true market value.
2. Run it through the matching tab.
3. Check the result against what you know: Is the item identified correctly? Are the
   price targets reasonable? Do the risk flags make sense?
4. Verify the listing and the item yourself before acting on any result.
5. Record what happened using `feedback-template.md`.

## Guardrails

- Do not paste passwords, payment details, or other people's personal information.
  Listing text is saved to your account history.
- A share link is readable by anyone who has the URL until you revoke it. It shows the
  title, category, asking price, condition, date, and recommendation — never the raw
  listing text.
- DealTough is decision support, not financial, legal, authentication, or appraisal
  advice. A good score does not guarantee resale price or timing.
- Stop and report anything that looks wrong: misidentified items, prices far from
  reality, errors, or results that contradict the listing.

## For developers

Running the engine locally is only needed for code work, not for testing the product.
Follow the **Run it locally** section of the repository `README.md` (Node 20 per
`.nvmrc`). The environment variables are listed there; every one is optional locally
and the affected feature switches off without it. There is no `.env.example` file —
never commit a `.env` file or any credential.

The engine can be exercised offline with no credentials:

```bash
npx tsx examples/run-example.ts
```

API payloads for `POST /api/v1/deals/analyze` follow `deal-input.schema.json`.

## Package contents

- `docs/private-beta/README.md` — this guide
- `docs/private-beta/feedback-template.md` — structured tester feedback
- `docs/private-beta/release-checklist.md` — owner checklist before inviting testers
- `docs/private-beta/known-limitations.md` — current limits, and when not to rely on a result
