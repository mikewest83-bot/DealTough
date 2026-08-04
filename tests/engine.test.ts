import { describe, expect, it } from "vitest";
import { analyzeDeal } from "../src/index.js";

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
