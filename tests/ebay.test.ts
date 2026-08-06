import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The lookup reads these at call time; without them fetchComparables throws
// before it ever builds a URL.
process.env.EBAY_CLIENT_ID = "test-client-id";
process.env.EBAY_CLIENT_SECRET = "test-client-secret";

const {
  clearComparableCache,
  fetchComparables,
  mapBrowseResultsToComparables,
  mapItemSalesToComparables,
  normalizeCondition,
  titleSimilarity,
} = await import("../src/ebay.js");

// Real titles from a live Weber Genesis II search. All 50 results were parts;
// the accessory list caught only the ones saying "cover".
describe("machine wear parts are not the machine", () => {
  const grillParts = [
    "Weber Genesis 300 Flavorizer Bars 5 Pack Porcelain Enameled 7620 7621",
    "Burner Tubes for Weber Genesis II 300 Series Gas Grill E310 E315 E335",
    "CANDANA Warming Rack for Weber Genesis II 300 Series Gas Grill",
    "WEBER GENESIS II 310 NG NATURAL GAS or LPG PROPANE GRILL ORIFICES",
    "Gas Grill Replacement Parts Manifold Main Burner Control Valve for Weber",
    "Grill Griddle 7658 for Weber Grill Griddle Spirit 200 300 Genesis Silver",
  ];

  for (const title of grillParts) {
    it(`drops "${title.slice(0, 40)}..."`, () => {
      const result = mapBrowseResultsToComparables(
        { itemSummaries: [{ title, price: { value: "49.89", currency: "USD" } }] },
        "Weber Genesis II E-310 gas grill",
      );

      expect(result).toEqual([]);
    });
  }

  it("keeps the grill itself", () => {
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [{
          title: "Weber Genesis II E-310 3 Burner Propane Gas Grill Black",
          price: { value: "399.00", currency: "USD" },
        }],
      },
      "Weber Genesis II E-310 gas grill",
    );

    expect(result).toHaveLength(1);
  });

  it("does not drop a part when the part is what you are shopping for", () => {
    // The markers only disqualify when absent from the reference title.
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [{
          title: "Weber Genesis 300 Flavorizer Bars Stainless Steel",
          price: { value: "49.89", currency: "USD" },
        }],
      },
      "Weber Genesis flavorizer bars",
    );

    expect(result).toHaveLength(1);
  });
});

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

// Taken from a live production search. Every one of these passed the
// relevance and accessory filters -- the parts are for the right truck and
// none of them use a word on the accessory list -- so the word list alone
// cannot separate them from the two real vehicles.
const realF150Search = {
  itemSummaries: [
    { title: "2015-2019 Ford F-150 XLT Super Crew Leather SEMA Black Gray F150 NEW", price: { value: "755.00" } },
    { title: "2019 Ford F-150 XLT Super Crew Leather SEMA Black Gray F150 NEW", price: { value: "755.00" } },
    { title: "2015 2016 17 18 2019 2020 Ford F-150 XLT SuperCrew Leather SEMA Limited", price: { value: "799.00" } },
    { title: "For Ford F150 F-150 XLT SuperCrew 4x4 Front Radiator Grille Magma Red", price: { value: "210.99" } },
    { title: "For 2018-2020 Ford F-150 F150 XL XLT SuperCrew Front Upper Grille Blue", price: { value: "149.99" } },
    { title: "2019 Ford F-150 SUPERCREW", price: { value: "23995.00" } },
    { title: "2019 Ford F-150 XLT Super Crew Katzkin Leather SEMA Black Gray F150 NEW", price: { value: "1595.00" } },
    { title: "2015-2026 Ford F150 XLT SuperCrew Front Left Door Window Glass ML34-1521", price: { value: "222.33" } },
    { title: "2019 Ford F150 SuperCrew Cab XLT Pickup 4D 5 1/2 ft", price: { value: "29985.00" } },
    { title: "2019 Ford F150 XLT Super Crew OEM Gray Cloth Rear Seat", price: { value: "534.05" } },
  ],
};

const F150_TITLE = "2019 Ford F-150 XLT SuperCrew";

describe("parts priced far below the asking price", () => {
  it("discards the parts and keeps the actual vehicles", () => {
    const result = mapBrowseResultsToComparables(realF150Search, F150_TITLE, 28000);

    expect(result.map((c) => c.price).sort((a, b) => a - b)).toEqual([23995, 29985]);
  });

  // The regression this was written for. With the parts left in, they
  // outnumber the vehicles 8 to 2 and pull the median down to $755 -- at which
  // point the outlier pass throws out the only two real trucks as anomalies,
  // and the engine values a $28,000 pickup at a few hundred dollars.
  it("without an asking price, the outlier pass discards the vehicles instead", () => {
    const result = mapBrowseResultsToComparables(realF150Search, F150_TITLE);

    expect(result.map((c) => c.price)).not.toContain(23995);
    expect(result.map((c) => c.price)).not.toContain(29985);
  });

  it("keeps every comparable when the floor would leave nothing", () => {
    // A listing priced at ten times the market: the asking price is the
    // outlier here, not the comparables, so they must survive to say so.
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [
          { title: "Sony WH-1000XM5 Wireless", price: { value: "180" } },
          { title: "Sony WH-1000XM5 Wireless Black", price: { value: "195" } },
        ],
      },
      "Sony WH-1000XM5 Wireless",
      9000,
    );

    expect(result.map((c) => c.price).sort((a, b) => a - b)).toEqual([180, 195]);
  });

  it("ignores a missing or nonsensical asking price", () => {
    for (const asking of [undefined, 0, -50, Number.NaN]) {
      const result = mapBrowseResultsToComparables(realF150Search, F150_TITLE, asking);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("applies the same floor to sold comparables", () => {
    const result = mapItemSalesToComparables(
      {
        itemSales: [
          { title: "2019 Ford F-150 XLT SuperCrew", lastSoldPrice: { value: "26500" } },
          { title: "2019 Ford F-150 XLT SuperCrew Grille", lastSoldPrice: { value: "180" } },
        ],
      },
      F150_TITLE,
      28000,
    );

    expect(result.map((c) => c.price)).toEqual([26500]);
  });
});

describe("category-constrained search", () => {
  let requestedUrls: string[];

  beforeEach(() => {
    clearComparableCache();
    requestedUrls = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/identity/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ itemSummaries: [] }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearComparableCache();
  });

  function searchUrl(): string {
    return requestedUrls.find((u) => u.includes("item_summary/search")) ?? "";
  }

  it("constrains a vehicle search to Cars & Trucks", async () => {
    await fetchComparables({ title: F150_TITLE, category: "vehicle" });

    expect(searchUrl()).toContain("category_ids=6001");
  });

  it("constrains a tools search to Tools & Workshop Equipment", async () => {
    await fetchComparables({ title: "DeWalt DCD791 drill", category: "tools" });

    expect(searchUrl()).toContain("category_ids=631");
  });

  // One id per request is all Browse allows, and no single id covers both
  // headphones and laptops -- so electronics searches all of eBay on purpose.
  it("leaves electronics unconstrained", async () => {
    await fetchComparables({ title: "Sony WH-1000XM5", category: "electronics" });

    expect(searchUrl()).not.toContain("category_ids");
  });

  it("does not serve one category's answer to another", async () => {
    await fetchComparables({ title: "Ranger", category: "vehicle" });
    requestedUrls = [];
    await fetchComparables({ title: "Ranger", category: "tools" });

    expect(searchUrl()).toContain("category_ids=631");
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
