import { describe, expect, it } from "vitest";
import { analyzeDeal } from "../src/index.js";

// Without a Marketplace Insights grant every comparable eBay returns is an
// active listing. The sold weighting in comparableWeight is relative, so in
// that case it cancels out and fair market value silently becomes an average
// of what sellers are asking.
describe("asking prices are not selling prices", () => {
  const listing = {
    category: "electronics" as const,
    title: "Sony WH-1000XM5",
    askingPrice: 190,
    condition: "good" as const,
    hiddenCosts: [],
    riskSignals: [],
  };
  const prices = [200, 210, 190, 205];
  const comparables = (sold: boolean) =>
    prices.map((price) => ({ price, similarity: 0.9, sold }));

  it("values a set of active listings below the same prices as completed sales", () => {
    const sold = analyzeDeal({ ...listing, comparables: comparables(true) });
    const active = analyzeDeal({ ...listing, comparables: comparables(false) });

    expect(active.fairMarketValue).toBeLessThan(sold.fairMarketValue);
    expect(active.fairMarketValue / sold.fairMarketValue).toBeCloseTo(0.88, 2);
  });

  it("scales the adjustment down as real sales enter the set", () => {
    const active = analyzeDeal({ ...listing, comparables: comparables(false) });
    const mixed = analyzeDeal({
      ...listing,
      comparables: [
        { price: 200, similarity: 0.9, sold: true },
        { price: 210, similarity: 0.9, sold: true },
        { price: 190, similarity: 0.9, sold: false },
        { price: 205, similarity: 0.9, sold: false },
      ],
    });
    const sold = analyzeDeal({ ...listing, comparables: comparables(true) });

    expect(mixed.fairMarketValue).toBeGreaterThan(active.fairMarketValue);
    expect(mixed.fairMarketValue).toBeLessThan(sold.fairMarketValue);
  });

  it("leaves completed sales alone", () => {
    const sold = analyzeDeal({ ...listing, comparables: comparables(true) });

    expect(sold.assumptions.join(" ")).not.toContain("asking");
  });

  it("says so in the report rather than adjusting silently", () => {
    const active = analyzeDeal({ ...listing, comparables: comparables(false) });

    expect(active.assumptions.join(" ")).toContain("No completed sales were available");
    expect(active.assumptions.join(" ")).toContain("12%");
  });

  it("reports lower confidence for asking prices than for completed sales", () => {
    // The haircut corrects the estimate; it does not make the estimate any
    // better known. Confidence has to fall too, or the report understates
    // how much of itself is inference.
    const sold = analyzeDeal({ ...listing, comparables: comparables(true) });
    const active = analyzeDeal({ ...listing, comparables: comparables(false) });

    expect(active.confidencePercent).toBeLessThan(sold.confidencePercent);
  });

  it("does not penalize confidence when there were no comparables either way", () => {
    // Nothing to grade the quality of — the missing-comparable penalty
    // already covers this case, and charging twice would double-count.
    const none = analyzeDeal({ ...listing, comparables: [] });

    expect(none.confidencePercent).toBeGreaterThan(0);
  });

  it("does not adjust when there are no comparables to adjust", () => {
    const none = analyzeDeal({ ...listing, comparables: [] });

    expect(none.fairMarketValue).toBe(190);
    expect(none.assumptions.join(" ")).not.toContain("asking and selling");
  });
});

// A live search for "Weber Genesis II E-310 gas grill" returned 50 results and
// not one of them was a grill — flavorizer bars, burner tubes and warming
// racks, medianing $46 against a $400 asking price. The price floor removed
// all of them and then put them back, because removing everything is how an
// overpriced listing gets rated fair.
describe("comparables that are all far below the asking price", () => {
  const grill = {
    category: "outdoor_equipment" as const,
    title: "Weber Genesis II E-310 gas grill",
    askingPrice: 400,
    condition: "good" as const,
    hiddenCosts: [],
    riskSignals: [],
  };
  const parts = [15.99, 27.95, 34.99, 48.99, 49.89].map((price) => ({
    price,
    similarity: 0.6,
  }));

  it("warns rather than quietly reporting a parts price as the market", () => {
    const result = analyzeDeal({ ...grill, comparables: parts });

    expect(result.assumptions.join(" ")).toContain("parts and accessories");
  });

  it("still uses them, because the listing might simply be overpriced", () => {
    // Discarding them would fall back to the asking price and rate a $400
    // ask for a $46 item as fair. That is the more expensive error.
    const result = analyzeDeal({ ...grill, comparables: parts });

    expect(result.fairMarketValue).toBeLessThan(100);
  });

  it("reports lower confidence than a comparable set that is not suspect", () => {
    const suspect = analyzeDeal({ ...grill, comparables: parts });
    const sane = analyzeDeal({
      ...grill,
      comparables: parts.map((c) => ({ ...c, price: c.price * 8 })),
    });

    expect(suspect.confidencePercent).toBeLessThan(sane.confidencePercent);
  });

  it("does not fire when even one comparable is priced like the item", () => {
    const result = analyzeDeal({
      ...grill,
      comparables: [...parts, { price: 380, similarity: 0.9 }],
    });

    expect(result.assumptions.join(" ")).not.toContain("parts and accessories");
  });
});

describe("DealTough Intelligence Engine", () => {
  it("rewards a materially below-market low-risk deal", () => {
    const result = analyzeDeal({
      category: "tools",
      title: "Cordless tool bundle",
      askingPrice: 400,
      condition: "good",
      daysListed: 35,
      priceReductionCount: 1,
      requiredFieldsPresent: 0.9,
      photoQuality: 0.9,
      demandIndex: 0.6,
      inventoryIndex: 0.7,
      comparables: [
        { price: 700, similarity: 0.9, sold: true },
        { price: 750, similarity: 0.8, sold: true },
        { price: 680, similarity: 0.85, sold: true },
      ],
      hiddenCosts: [{ label: "Replacement blade", amount: 25 }],
      riskSignals: [],
    });

    expect(result.dealScore).toBeGreaterThanOrEqual(75);
    expect(result.trueCost).toBe(425);
    expect(result.walkAwayPrice).toBeGreaterThan(result.openingOffer);
  });

  it("never allows critical risk to score above Walk Away", () => {
    const result = analyzeDeal({
      category: "electronics",
      title: "Current smartphone",
      askingPrice: 100,
      condition: "like_new",
      comparables: [{ price: 800, similarity: 0.95, sold: true }],
      hiddenCosts: [],
      riskSignals: [{
        code: "ACTIVATION_LOCK",
        label: "Possible activation lock",
        severity: "critical",
      }],
    });

    expect(result.dealScore).toBeLessThanOrEqual(39);
    expect(result.verdict).toBe("Walk Away");
    expect(result.riskLevel).toBe("Critical");
  });

  it("lowers confidence when comparables and listing data are missing", () => {
    const result = analyzeDeal({
      category: "furniture",
      title: "Sectional sofa",
      askingPrice: 500,
      condition: "unknown",
      comparables: [],
      requiredFieldsPresent: 0.25,
      photoQuality: 0.2,
    });

    expect(result.confidencePercent).toBeLessThan(50);
    expect(result.assumptions.length).toBeGreaterThan(0);
  });
});

describe("condition-aware comparables", () => {
  const base = {
    category: "electronics" as const,
    title: "Sony WH-1000XM5",
    askingPrice: 200,
    condition: "fair" as const,
    hiddenCosts: [],
    riskSignals: [],
  };

  it("leans on the comparables that match the listing's condition", () => {
    // Same prices, opposite labels. Whichever set matches "fair" should
    // pull the market value toward it.
    const cheapIsFair = analyzeDeal({
      ...base,
      comparables: [
        { price: 100, similarity: 1, condition: "fair" },
        { price: 400, similarity: 1, condition: "new" },
      ],
    });

    const cheapIsNew = analyzeDeal({
      ...base,
      comparables: [
        { price: 100, similarity: 1, condition: "new" },
        { price: 400, similarity: 1, condition: "fair" },
      ],
    });

    expect(cheapIsFair.fairMarketValue).toBeLessThan(cheapIsNew.fairMarketValue);
  });

  it("does not discount twice when comparables are already the listing's condition", () => {
    // The category condition discount exists to bridge a listing in poor
    // shape to a market of average ones. When every comparable is already
    // labeled the same as the listing, that bridge has been crossed.
    const labeled = analyzeDeal({
      ...base,
      comparables: [
        { price: 300, similarity: 1, condition: "fair" },
        { price: 300, similarity: 1, condition: "fair" },
      ],
    });

    const unlabeled = analyzeDeal({
      ...base,
      comparables: [
        { price: 300, similarity: 1 },
        { price: 300, similarity: 1 },
      ],
    });

    expect(labeled.fairMarketValue).toBeGreaterThan(unlabeled.fairMarketValue);
    expect(labeled.assumptions.join(" ")).toContain("counting the same wear twice");
  });

  it("keeps the full discount when the comparables are in better shape", () => {
    const betterComparables = analyzeDeal({
      ...base,
      comparables: [
        { price: 300, similarity: 1, condition: "new" },
        { price: 300, similarity: 1, condition: "new" },
      ],
    });

    const unlabeled = analyzeDeal({
      ...base,
      comparables: [
        { price: 300, similarity: 1 },
        { price: 300, similarity: 1 },
      ],
    });

    expect(betterComparables.fairMarketValue).toBe(unlabeled.fairMarketValue);
  });

  it("ignores condition entirely when the listing's own condition is unknown", () => {
    const withLabels = analyzeDeal({
      ...base,
      condition: "unknown",
      comparables: [
        { price: 300, similarity: 1, condition: "new" },
        { price: 320, similarity: 1, condition: "poor" },
      ],
    });

    const withoutLabels = analyzeDeal({
      ...base,
      condition: "unknown",
      comparables: [
        { price: 300, similarity: 1 },
        { price: 320, similarity: 1 },
      ],
    });

    expect(withLabels.fairMarketValue).toBe(withoutLabels.fairMarketValue);
  });
});
