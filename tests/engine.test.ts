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
