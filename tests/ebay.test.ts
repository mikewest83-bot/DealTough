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
// Real titles from live searches. The C6 case is the dangerous one: it
// inflates value, which is the direction that tells someone to buy.
// Browse ANDs the query, so the full listing title often matches nothing.
describe("broadening an over-specific query", () => {
  const queries: string[] = [];

  const respondWith = (counts: number[]) => {
    let call = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 7200 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      queries.push(url.searchParams.get("q") ?? "");
      const n = counts[Math.min(call++, counts.length - 1)];
      return new Response(
        JSON.stringify({
          itemSummaries: Array.from({ length: n }, () => ({
            title: "2015 Honda Civic EX Sedan",
            price: { value: "11000.00", currency: "USD" },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  };

  beforeEach(() => {
    queries.length = 0;
    clearComparableCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shortens the title until eBay returns something to work with", async () => {
    respondWith([0, 0, 12]);

    await fetchComparables({ title: "2015 Honda Civic EX sedan", category: "vehicle" });

    expect(queries).toEqual([
      "2015 Honda Civic EX sedan",
      "2015 Honda Civic EX",
      "2015 Honda Civic",
    ]);
  });

  it("asks once when the full title already answers", async () => {
    respondWith([20]);

    await fetchComparables({ title: "2015 Honda Civic EX sedan", category: "vehicle" });

    expect(queries).toEqual(["2015 Honda Civic EX sedan"]);
  });

  it("never goes below three words", async () => {
    respondWith([0, 0, 0, 0]);

    await fetchComparables({ title: "2015 Honda Civic EX sedan", category: "vehicle" });

    expect(queries).toHaveLength(3);
    for (const q of queries) {
      expect(q.split(" ").length).toBeGreaterThanOrEqual(3);
    }
  });

  it("does not broaden a title that is already short", async () => {
    respondWith([0]);

    await fetchComparables({ title: "Herman Miller Aeron", category: "furniture" });

    expect(queries).toEqual(["Herman Miller Aeron"]);
  });

  it("still judges relevance against the full title, not the shortened query", async () => {
    // The broadened query returns a Civic; the reference is a Civic. If
    // relevance were scored against "2015 Honda Civic" the extra words in the
    // reference would be invisible, which is the same bug in reverse.
    respondWith([0, 0, 10]);

    const result = await fetchComparables({
      title: "2015 Honda Civic EX sedan",
      category: "vehicle",
    });

    expect(result.length).toBeGreaterThan(0);
  });
});

describe("a model number is not optional", () => {
  const keep = (reference: string, title: string) =>
    mapBrowseResultsToComparables(
      { itemSummaries: [{ title, price: { value: "500.00", currency: "USD" } }] },
      reference,
    ).length;

  it("rejects next year's model of the same product line", () => {
    const reference = "LG C2 65 inch OLED TV";

    expect(keep(reference, "LG 65 inch OLED evo AI C6 4K Smart webOS TV (2026)")).toBe(0);
    expect(keep(reference, "LG OLED65C5P 65” C5 OLED evo 4K Smart TV 2025")).toBe(0);
    expect(keep(reference, "LG OLED65C2PUA 65 inch C2 OLED evo 4K Smart TV")).toBe(1);
  });

  it("keeps trim levels of the model the search named", () => {
    // hrx217hya and hrx217vka4 are the same mower with different transmissions.
    const reference = "Honda HRX217 self propelled lawn mower";

    expect(keep(reference, 'Honda HRX217HYA 21" Self Propelled Lawn Mower w Roto Stop')).toBe(1);
    expect(keep(reference, "Honda HRX217VKA4 21 in. NeXite Self Propelled Lawn Mower")).toBe(1);
  });

  it("still matches a truck whose listing spells the model differently", () => {
    expect(keep("2019 Ford F-150 XLT SuperCrew 4x4", "2019 Ford F-150 SUPERCREW")).toBe(1);
  });

  it("stays out of the way when the search names no model at all", () => {
    // Nothing to enforce; this must not become a filter on plain-English titles.
    expect(keep("solid oak dining table seats 6", "Solid Oak Dining Table Farmhouse")).toBe(1);
    expect(keep("Herman Miller Aeron chair size B", "Herman Miller Aeron Chair Graphite")).toBe(1);
  });
});

// A search for one table should not be priced against a table plus six chairs.
describe("bundles are not single items", () => {
  const keep = (reference: string, title: string) =>
    mapBrowseResultsToComparables(
      { itemSummaries: [{ title, price: { value: "1900.00", currency: "USD" } }] },
      reference,
    ).length;

  it("rejects multi-piece dining sets when the search wanted a table", () => {
    const reference = "solid oak dining table seats 6";

    expect(keep(reference, "Elements Summerville 6-Piece Dining Set Oak Antique White")).toBe(0);
    expect(keep(reference, "7 Pc Brown Oak Dining Set Kitchen Butterfly Leaf Table")).toBe(0);
  });

  it("keeps them when a set is what the search asked for", () => {
    expect(keep("oak dining set 6 piece", "Elements Summerville 6-Piece Dining Set Oak")).toBe(1);
  });
});

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

// Real titles and prices from a live search for this saw in Tools & Workshop
// Equipment (Oct 2026). About sixty results came back and one was the saw.
describe("parts sold under the machine's name", () => {
  const reference = "DeWalt DWE7491RS table saw";
  const saw = {
    title: 'DEWALT DWE7491RS 10" Jobsite Table Saw 32 1/2 in Rip Capacity & Rolling Stand',
    price: "563.06",
  };
  const parts: Array<[string, string]> = [
    ["34.23", "New Dewalt OEM N603746 Table Saw Switch DWE7485 DWE7491RS DWE7491RS"],
    ["54.86", "New Dewalt OEM N507600 Table Saw Guard DWE7491RS DWE7491RS DWE7491RS DWE7491RS"],
    ["29.95", "Dewalt Genuine OEM Miter Gauge for DCS7485/DWE7491 Table Saw - N435108"],
    ["299.99", "NEW OEM Dewalt DWE7491RS Table Saw REPLACEMENT MOTOR, Complete"],
    ["14.81", 'Dado Throat Plate Compatible with Dewalt 10" Portable Table Saw DWE7490 DWE7491'],
    ["37.33", "New Dewalt OEM N507744 Table Saw Fence Beam DWE7491RS DWE7491RS"],
    ["15.65", "New Dewalt OEM N507485 Table Saw Rail DWE7491RS DWE7491RS"],
    ["69.24", "New Dewalt OEM N645999 Table Saw Field DWE7491RS DWE7491RS"],
    ["28.73", "New DeWalt OEM 5140135-51 5140135-51-2 Table Saw Bevel Handle (2 Pack) DWE7491RS"],
    ["24.99", "Genuine DeWalt N507559 Miter Gauge Replacement For DWE7491RS Table Saw"],
    ["27.00", "DEWALT DWE7402DI Table Saw Dado Insert Plate for DWE7491RS DWE7485"],
    ["24.99", "NEW OEM Dewalt DWE7491RS Table Saw POWER CORD w/ Left & Right BRACKETS ASSY"],
    ["12.99", "2 Pack Table Saw Wrench N506977 for Dewalt Table Saw DWE7485 DWE7491RS DWE7491RS"],
    ["29.00", "DEWALT DWE7491RS 10 in Jobsite Table Saw PARTS MITER GAUGE ASSY DWB-N435108- W19"],
    ["24.95", "DeWalt Table Saw Zero Clearance Insert - DWE7491, DWE7492, DWE7491RS, DWE7480, D"],
    ["22.54", "For De-walt Miter Gauge For DWE7491RS Table Saw - N507559"],
    ["27.50", "N603746 Table Saw Switch Replacement for Dewalt Table Saw DWE7485 DWE7491RS"],
    ["15.90", "Table Saw Wrench Hardened Steel for DeWalt DWE7490X DWE7485 DWE7491RS DWE7499GD"],
    ["29.99", "Zero Clearance Throat Plate Insert for DeWalt DWE7491 Table Saw Yellow 1 pc NEW"],
    ["9.51", "QTY 2 Compatible w/DeWalt 5140134-79 Table Saw Fence Knob DWE7490X DWE7491RS B"],
    ["10.79", "New Dewalt OEM N506822 Table Saw Fence Knob DWE7491RS DWE7491RS"],
    ["7.99", "New Dewalt OEM N539048 Table Saw Brush Cap DWE7491RS DWE7491RS"],
    ["17.10", "New Dewalt OEM N506922 Table Saw Cover DWE7491RS DWE7491RS"],
  ];
  const liveResults = {
    itemSummaries: [
      ...parts.slice(0, 2).map(([value, title]) => ({ title, price: { value } })),
      { title: saw.title, price: { value: saw.price }, condition: "New" },
      ...parts.slice(2).map(([value, title]) => ({ title, price: { value } })),
      // A different saw from the same search: wrong model, already rejected.
      { title: "DEWALT 15 Amp 8-1/4 in. Compact Portable Jobsite Table Saw (DWE7485)", price: { value: "337.76" } },
    ],
  };

  for (const [price, title] of parts) {
    it(`drops "${title.slice(0, 48)}..."`, () => {
      const result = mapBrowseResultsToComparables(
        { itemSummaries: [{ title, price: { value: price } }] },
        reference,
      );
      expect(result).toEqual([]);
    });
  }

  it("keeps the saw, however its seller lists what comes with it", () => {
    const whole = [
      saw.title,
      "DeWalt DWE7491RS 10 in Table Saw with Rolling Stand, Fence and Blade Guard - Used",
      "DEWALT DWE7491RS Table Saw w/ stand - local pickup, works great, for sale",
      "DeWalt DWE7491RS jobsite table saw for woodworking, lightly used",
    ];
    for (const title of whole) {
      const result = mapBrowseResultsToComparables(
        { itemSummaries: [{ title, price: { value: "400.00" } }] },
        reference,
      );
      expect(result, title).toHaveLength(1);
    }
  });

  it("values the saw the same whatever the seller is asking", () => {
    const withoutPrice = mapBrowseResultsToComparables(liveResults, reference);
    expect(withoutPrice.map((c) => c.price)).toEqual([563.06]);
    // Before: $8 parts with no asking price, and a different answer at each of these.
    for (const asking of [100, 225, 450]) {
      expect(mapBrowseResultsToComparables(liveResults, reference, asking)).toEqual(withoutPrice);
    }
  });

  it("does not drop a part when the part is what you are shopping for", () => {
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [
          { title: "Dewalt Genuine OEM Miter Gauge for DWE7491RS Table Saw - N507559", price: { value: "30.45" } },
          { title: "For De-walt Miter Gauge For DWE7491RS Table Saw - N507559", price: { value: "22.54" } },
        ],
      },
      "Miter gauge for DeWalt DWE7491RS table saw",
    );
    expect(result).toHaveLength(2);

    const motor = mapBrowseResultsToComparables(
      { itemSummaries: [{ title: "NEW OEM Dewalt DWE7491RS Table Saw REPLACEMENT MOTOR, Complete", price: { value: "299.99" } }] },
      "DeWalt DWE7491RS replacement motor OEM",
    );
    expect(motor).toHaveLength(1);
  });

  it("keeps a combo kit that names its own contents", () => {
    const result = mapBrowseResultsToComparables(
      {
        itemSummaries: [{
          title: "DEWALT DCK299P2 20V MAX XR Hammer Drill & Impact Driver Combo Kit DCD996 DCF887",
          price: { value: "329.00" },
        }],
      },
      "DeWalt DCK299P2 20V combo kit",
    );
    expect(result).toHaveLength(1);
  });

  it("leaves other kinds of listing alone", () => {
    const kept: Array<[string, string]> = [
      ["Apple iPhone 13 128GB", "Apple iPhone 13 128GB Unlocked - compatible with Verizon AT&T T-Mobile"],
      ["2019 Ford F-150 XLT", "2019 Ford F-150 XLT SuperCrew 4x4 - one owner, ready for work"],
      ["Oak dining table", "Solid oak dining table, some assembly required"],
      ["Honda EU2200i generator", "Honda EU2200i 2200W Inverter Generator - great for camping"],
      ["Milwaukee 2804-20 hammer drill", "Milwaukee 2804-20 M18 FUEL 1/2 in Hammer Drill (Tool Only)"],
    ];
    for (const [ref, title] of kept) {
      const result = mapBrowseResultsToComparables(
        { itemSummaries: [{ title, price: { value: "250.00" } }] },
        ref,
      );
      expect(result, title).toHaveLength(1);
    }
  });

  it("does not mistake ordinary words for accessory words", () => {
    // "pin" inside shipping, camping and pine; "case" inside bookcase; "hat"
    // inside that; "cover" inside discover.
    const kept: Array<[string, string]> = [
      ["DeWalt DWE7491RS table saw", "DeWalt DWE7491RS Table Saw with Stand - Free Shipping"],
      ["6 drawer dresser", "Solid Pine 6 Drawer Dresser"],
      ["Oak bookshelf", "Oak Bookshelf Bookcase 5 Shelf"],
      ["Weber Genesis II E-310 gas grill", "Weber Genesis II E-310 Gas Grill that works great"],
    ];
    for (const [ref, title] of kept) {
      const result = mapBrowseResultsToComparables(
        { itemSummaries: [{ title, price: { value: "250.00" } }] },
        ref,
      );
      expect(result, title).toHaveLength(1);
    }
    // The accessories themselves are still dropped, singular or plural.
    const dropped: Array<[string, string]> = [
      ["Apple iPhone 13 128GB", "Apple iPhone 13 128GB Cases 3 colors"],
      ["2019 Ford F-150 XLT", "2019 Ford F-150 XLT Seat Covers"],
      ["Apple iPhone 13 128GB", "Apple iPhone 13 128GB lapel pin"],
    ];
    for (const [ref, title] of dropped) {
      const result = mapBrowseResultsToComparables(
        { itemSummaries: [{ title, price: { value: "20.00" } }] },
        ref,
      );
      expect(result, title).toEqual([]);
    }
  });

  it("drops parts for other machines written the same way", () => {
    const dropped: Array<[string, string]> = [
      ["Honda EU2200i generator", "Carburetor Kit Fits Honda EU2200i EU2200 Generator Carb"],
      ["Honda EU2200i generator", "Generator parallel cables compatible with Honda EU2200i EU2000i"],
      ["Milwaukee 2804-20 hammer drill", "OEM Milwaukee 2804-20 Hammer Drill Chuck 42-66-0935"],
      ["Makita LS1019L miter saw", "3 Pack carbon brushes for Makita LS1019L LS1219L miter saw"],
    ];
    for (const [ref, title] of dropped) {
      const result = mapBrowseResultsToComparables(
        { itemSummaries: [{ title, price: { value: "25.00" } }] },
        ref,
      );
      expect(result, title).toEqual([]);
    }
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

describe("sold-search query ladder", () => {
  const queries: string[] = [];

  const respondWithSold = (counts: number[]) => {
    let call = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 7200 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (!url.pathname.includes("item_sales")) {
        return new Response(JSON.stringify({ itemSummaries: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      queries.push(url.searchParams.get("q") ?? "");
      const n = counts[Math.min(call++, counts.length - 1)];
      return new Response(
        JSON.stringify({
          itemSales: Array.from({ length: n }, () => ({
            title: "2015 Honda Civic EX Sedan",
            lastSoldPrice: { value: "10500.00" },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  };

  beforeEach(() => {
    queries.length = 0;
    clearComparableCache();
    process.env.EBAY_MARKETPLACE_INSIGHTS = "1";
  });
  afterEach(() => {
    delete process.env.EBAY_MARKETPLACE_INSIGHTS;
    vi.unstubAllGlobals();
  });

  it("shortens the sold query until completed sales come back", async () => {
    respondWithSold([0, 0, 12]);

    const result = await fetchComparables({
      title: "2015 Honda Civic EX sedan",
      category: "vehicle",
    });

    expect(queries).toEqual([
      "2015 Honda Civic EX sedan",
      "2015 Honda Civic EX",
      "2015 Honda Civic",
    ]);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((item) => item.sold)).toBe(true);
  });

  it("stops the sold ladder once enough completed sales are in hand", async () => {
    respondWithSold([20]);

    await fetchComparables({ title: "2015 Honda Civic EX sedan", category: "vehicle" });

    expect(queries).toEqual(["2015 Honda Civic EX sedan"]);
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
