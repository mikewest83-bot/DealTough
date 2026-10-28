# DealTough Known Limitations

Treat every result as research assistance and check it yourself before buying or
selling. These are the current, known limits — see "Honest limitations" in the
repository `README.md` for the technical detail behind each.

## Comparables are asking prices, not sold prices

- eBay sold-price data is not available to DealTough, so comparables are **active
  listings** — what sellers are asking, not what buyers paid.
- The engine discounts active listings by up to 12% to approximate selling prices. That
  figure is a calibration estimate, not a measurement. The result shows which kind of
  comparables it used.

## Item identification

- Results depend on DealTough identifying the right item. Generic titles pull noisy
  comparables; relevance filtering removes the worst of them and lowers the reported
  confidence rather than hiding the problem.
- Some items are barely listed on eBay, or are outnumbered by their own parts and
  accessories. When the remaining comparables are priced far below the asking price,
  DealTough says so and halves its confidence.
- With no usable comparables at all, the verdict is **Insufficient Data** rather than a
  guess.

## Vehicles

- Vehicle comparables are thinner than electronics. Results are much better when the
  listing includes a VIN, which is decoded to the exact year, make, model, and trim.
- Where a VIN-specific dealer-listing value is available, it is used only when enough
  listings back it; otherwise DealTough falls back to eBay comparables.
- No result replaces a pre-purchase inspection or a vehicle history report.

## Costs outside the listing

- Taxes, shipping, marketplace fees, returns, repairs, and authentication can change what
  a deal is really worth. Missing details can make a good-looking result wrong.

## Operational

- eBay and Anthropic can throttle or interrupt service. An error or partial result is
  not a positive or negative verdict — rerun it or report it.
- Listing analysis and Sell Something are each limited to 6 requests a minute per IP
  address, and each account has a monthly analysis allowance.
- Output format and features may change as feedback is incorporated.

## When to stop

Do not act on DealTough alone when the item is misidentified, confidence is low,
comparables are few, critical costs are missing, or the result conflicts with the
listing. Report the case using `feedback-template.md`.
