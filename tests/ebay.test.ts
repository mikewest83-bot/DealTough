import { describe, expect, it } from "vitest";
import {
  mapBrowseResultsToComparables,
  mapItemSalesToComparables,
  normalizeCondition,
  titleSimilarity,
} from "../src/ebay.js";

describe("mapBrowseResultsToComparables", () => {
  it("maps normal Browse API results to honestly-labeled comparables", () => {
    const result = mapBrowseResultsToComparables({
      itemSummaries: [
        { price: { value: "120.00", currency: "USD" } },
        { price: { value: "99.50", currency: "USD" } },
      ],
    });

    expect(result).toEqual([
      { price: 120, similarity: 0.5, source: "ebay_active", sold: false },
      { price: 99.5, similarity: 0.5, source: "ebay_active", sold: false },
    ]);
  });

  it("returns an empty array when there are no results", () => {
    expect(mapBrowseResultsToComparables({ itemSummaries: [] })).toEqual([]);
    expect(mapBrowseResultsToComparables({})).toEqual([]);
    expect(mapBrowseResultsToComparables(null)).toEqual([]);
  });

  it("skips items with missing or invalid prices", () => {
    const result = mapBrowseResultsToComparables({
      itemSummaries: [
        { price: {} },
        { price: { value: "not-a-number" } },
        { price: { value: "0" } },
        { price: { value: "50" } },
      ],
    });

    expect(result).toEqual([
      { price: 50, similarity: 0.5, source: "ebay_active", sold: false },
    ]);
  });
});

describe("mapBrowseResultsToComparables with a reference title", () => {
  // The case this filtering exists for: a truck search whose results are
  // mostly parts and toys. Unfiltered, the median of these is about $30.
  const truckResults = {
    itemSummaries: [
      { title: "2019 Ford F-150 XLT SuperCrew 4x4", price: { value: "28000" } },
      { title: "2019 Ford F150 Lariat Crew Cab", price: { value: "31500" } },
      { title: "2018 Ford F-150 XL Regular Cab", price: { value: "24000" } },
      { title: "Ford F-150 Floor Mat Set All Weather", price: { value: "45" } },
      { title: "1:24 Diecast Model 2019 Ford F-150 Truck Toy", price: { value: "19" } },
      { title: "F-150 Emblem Badge Chrome Replacement", price: { value: "12" } },
    ],
  };

  it("drops accessories and toys, keeping the actual trucks", () => {
    const result = mapBrowseResultsToComparables(truckResults, "2019 Ford F-150 XLT");

    expect(result.map((c) => c.price).sort((a, b) => a - b)).toEqual([24000, 28000, 31500]);
  });

  it("weights comparables by how well the title matches", () => {
    const result = mapBrowseResultsToComparables(truckResults, "2019 Ford F-150 XLT");
    const exact = result.find((c) => c.price === 28000);
    const olderYear = result.find((c) => c.price === 24000);

    // The 2019 XLT matches every token; the 2018 XL misses the year and trim.
    expect(exact!.similarity!).toBeGreaterThan(olderYear!.similarity!);
    expect(exact!.similarity).toBe(1);
  });

  it("keeps an accessory word when the buyer is shopping for that accessory", () => {
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [
          { title: "Anker 65W USB-C Charger Fast Charge", price: { value: "35" } },
          { title: "Anker 65W USB C Charger Block", price: { value: "29" } },
        ],
      },
      "Anker 65W USB-C Charger",
    );

    expect(result).toHaveLength(2);
  });

  it("rejects price outliers once there are enough comparables to judge", () => {
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [
          { title: "Apple iPhone 15 Pro 256GB", price: { value: "800" } },
          { title: "Apple iPhone 15 Pro 256GB Unlocked", price: { value: "820" } },
          { title: "Apple iPhone 15 Pro 256GB Grade A", price: { value: "790" } },
          { title: "Apple iPhone 15 Pro 256GB Sealed", price: { value: "810" } },
          { title: "Apple iPhone 15 Pro 256GB Lot of 10", price: { value: "8200" } },
        ],
      },
      "Apple iPhone 15 Pro 256GB",
    );

    expect(result.map((c) => c.price)).not.toContain(8200);
    expect(result).toHaveLength(4);
  });

  it("leaves small result sets alone rather than guessing at a distribution", () => {
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [
          { title: "Snap-on Ratchet Set 3/8", price: { value: "200" } },
          { title: "Snap-on Ratchet Set 3/8 Drive", price: { value: "900" } },
        ],
      },
      "Snap-on Ratchet Set 3/8",
    );

    expect(result).toHaveLength(2);
  });
});

describe("condition parsing", () => {
  it("maps eBay's condition wording onto the engine's scale", () => {
    expect(normalizeCondition("Brand New")).toBe("new");
    expect(normalizeCondition("Open box")).toBe("like_new");
    expect(normalizeCondition("Certified - Refurbished")).toBe("good");
    expect(normalizeCondition("Pre-owned")).toBe("good");
    expect(normalizeCondition("Used")).toBe("good");
    expect(normalizeCondition("Acceptable")).toBe("fair");
    expect(normalizeCondition("For parts or not working")).toBe("poor");
  });

  it("prefers the more specific phrase when both could match", () => {
    // "New other" contains "new", but it is not new.
    expect(normalizeCondition("New other (see details)")).toBe("like_new");
    // "For parts or not working" contains neither "new" nor "used".
    expect(normalizeCondition("For parts or not working")).not.toBe("new");
  });

  it("returns undefined rather than guessing at an unlabeled item", () => {
    expect(normalizeCondition(undefined)).toBeUndefined();
    expect(normalizeCondition("")).toBeUndefined();
    expect(normalizeCondition("Wibble")).toBeUndefined();
  });

  it("carries the condition through onto the comparable", () => {
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [
          { title: "Sony WH-1000XM5", price: { value: "250" }, condition: "Open box" },
          { title: "Sony WH-1000XM5", price: { value: "180" } },
        ],
      },
      "Sony WH-1000XM5",
    );

    expect(result[0].condition).toBe("like_new");
    expect(result[1].condition).toBeUndefined();
  });
});

describe("mapItemSalesToComparables", () => {
  it("reads sold prices from lastSoldPrice and marks them sold", () => {
    const result = mapItemSalesToComparables(
      {
        itemSales: [
          { title: "Sony WH-1000XM5 Headphones", lastSoldPrice: { value: "240" }, condition: "Used" },
          { title: "Sony WH-1000XM5 Black", lastSoldPrice: { value: "255" } },
        ],
      },
      "Sony WH-1000XM5",
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ price: 240, sold: true, source: "ebay_sold", condition: "good" });
  });

  it("applies the same relevance filtering as the active-listing path", () => {
    const result = mapItemSalesToComparables(
      {
        itemSales: [
          { title: "2019 Ford F-150 XLT", lastSoldPrice: { value: "28000" } },
          { title: "Ford F-150 Floor Mat Set", lastSoldPrice: { value: "45" } },
        ],
      },
      "2019 Ford F-150 XLT",
    );

    expect(result.map((c) => c.price)).toEqual([28000]);
  });

  it("returns an empty array when there are no sales", () => {
    expect(mapItemSalesToComparables({ itemSales: [] })).toEqual([]);
    expect(mapItemSalesToComparables({})).toEqual([]);
    expect(mapItemSalesToComparables(null)).toEqual([]);
  });
});

describe("titleSimilarity", () => {
  it("scores an exact match at 1 and an unrelated item near 0", () => {
    expect(titleSimilarity("Sony WH-1000XM5", "Sony WH-1000XM5 Headphones Black")).toBe(1);
    expect(titleSimilarity("Sony WH-1000XM5", "Dewalt Cordless Drill")).toBe(0);
  });

  it("collapses hyphens so model numbers survive tokenizing", () => {
    expect(titleSimilarity("Ford F-150", "Ford F150 Pickup")).toBe(1);
  });

  it("weights numeric tokens above descriptive ones", () => {
    // Same single token missed, but missing the model number costs more.
    const missedNumber = titleSimilarity("iPhone 15 Pro", "iPhone Pro Max");
    const missedWord = titleSimilarity("iPhone 15 Pro", "iPhone 15 Max");
    expect(missedWord).toBeGreaterThan(missedNumber);
  });
});
