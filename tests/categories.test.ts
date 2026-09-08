import { describe, expect, it } from "vitest";
import { CATEGORY_CONFIG } from "../src/config.js";
import { analyzeDeal } from "../src/engine.js";
import type { DealCategory, DealInput } from "../src/types.js";

// The category list is duplicated across config.ts, app.ts, market-value-route.ts
// and the Mike AI side. A category that reaches the engine without a config row
// throws "Cannot read properties of undefined (reading 'conditionDiscounts')",
// which is how a jewelry lookup used to fail. These tests fail loudly the next
// time the lists drift apart.
const CATEGORIES = Object.keys(CATEGORY_CONFIG) as DealCategory[];

function inputFor(category: DealCategory): DealInput {
  return {
    category,
    title: "Test item",
    askingPrice: 400,
    condition: "good",
    comparables: [
      { price: 520, source: "test", sold: false },
      { price: 480, source: "test", sold: false },
      { price: 610, source: "test", sold: false },
      { price: 495, source: "test", sold: false },
    ],
    riskSignals: [],
    requiredFieldsPresent: 0,
    photoQuality: 0,
  };
}

describe("category coverage", () => {
  it("covers every category the pawn-shop set expects", () => {
    expect(CATEGORIES).toEqual(
      expect.arrayContaining([
        "vehicle",
        "electronics",
        "tools",
        "furniture",
        "outdoor_equipment",
        "musical_instrument",
        "sporting_goods",
        "appliance",
        "collectible",
      ]),
    );
  });

  for (const category of CATEGORIES) {
    it(`${category} has a complete, sane config`, () => {
      const config = CATEGORY_CONFIG[category];
      expect(config).toBeDefined();
      for (const condition of ["new", "like_new", "good", "fair", "poor", "unknown"]) {
        const discount = config.conditionDiscounts[condition];
        expect(typeof discount).toBe("number");
        expect(discount).toBeGreaterThanOrEqual(0);
        expect(discount).toBeLessThan(1);
      }
      expect(config.conditionDiscounts.new).toBe(0);
      expect(config.negotiationFloorPercent).toBeGreaterThan(0);
      expect(config.negotiationFloorPercent).toBeLessThanOrEqual(1);
      expect(config.defaultHiddenCostRate).toBeGreaterThanOrEqual(0);
      expect(config.volatilityPenalty).toBeGreaterThanOrEqual(0);
    });

    it(`${category} scores a deal end to end`, () => {
      const report = analyzeDeal(inputFor(category));
      expect(report.valuationBasis).toBe("comparables");
      expect(report.fairMarketValue).toBeGreaterThan(0);
      expect(report.dealScore).toBeGreaterThanOrEqual(0);
      expect(report.dealScore).toBeLessThanOrEqual(100);
      // The price ladder has to stay in order or the negotiation advice is wrong.
      expect(report.openingOffer).toBeLessThanOrEqual(report.targetPrice);
      expect(report.greatDealPrice).toBeLessThanOrEqual(report.goodDealPrice);
      expect(report.sellerQuestions.length).toBeGreaterThan(0);
    });
  }
});
