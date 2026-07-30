import { describe, expect, it } from "vitest";
import { mapBrowseResultsToComparables } from "../src/ebay.js";

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
