import { afterEach, describe, expect, it } from "vitest";
import {
  decodeVin,
  fetchVinAuditValue,
  findMileage,
  findVin,
  isValidVin,
  vehicleSearchTitle,
  vinAuditComparables,
} from "../src/vehicle.js";
import { analyzeDeal } from "../src/engine.js";

// VINs with correct check digits (VIN_A is the VinAudit docs example).
const VIN_A = "1NXBR32E85Z505904";
const VIN_B = "11111111111111111"; // classic all-ones test VIN, valid check digit

const json = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("VIN parsing", () => {
  it("accepts VINs with a valid check digit and rejects others", () => {
    expect(isValidVin(VIN_A)).toBe(true);
    expect(isValidVin(VIN_B)).toBe(true);
    expect(isValidVin("1NXBR32E75Z505904")).toBe(false); // wrong check digit
    expect(isValidVin("1NXBR32E85Z50590")).toBe(false); // 16 chars
    expect(isValidVin("1NXBR32E85Z5059O4")).toBe(false); // letter O not allowed
  });

  it("finds a VIN inside listing text, case-insensitive", () => {
    expect(findVin(`Clean title. VIN: ${VIN_A.toLowerCase()} call me`)).toBe(VIN_A);
    expect(findVin("No VIN here, stock #ABCDEFGHJKLMNPRST")).toBeNull();
  });

  it("reads mileage in common listing formats and ignores prices", () => {
    expect(findMileage("2015 F-150, 140k miles, asking $18k")).toBe(140000);
    expect(findMileage("140,000 miles on it")).toBe(140000);
    expect(findMileage("Mileage: 92500")).toBe(92500);
    expect(findMileage("only 88,412 mi")).toBe(88412);
    expect(findMileage("asking 18k firm, 5 mi from town")).toBeNull();
  });
});

describe("NHTSA decode", () => {
  it("builds a precise search title from the decode", async () => {
    const fetchImpl = json({ Results: [{ ModelYear: "2015", Make: "FORD", Model: "F-150", Trim: "XLT", BodyClass: "Pickup" }] });
    const decoded = await decodeVin("1FTFW1EF1FFA00001", fetchImpl);
    expect(decoded).not.toBeNull();
    expect(vehicleSearchTitle(decoded!)).toBe("2015 Ford F-150 XLT");
  });

  it("returns null when the decode fails", async () => {
    expect(await decodeVin("1FTFW1EF1FFA00002", json({}, 500))).toBeNull();
    expect(await decodeVin("1FTFW1EF1FFA00003", json({ Results: [{ ModelYear: "", Make: "", Model: "" }] }))).toBeNull();
  });
});

describe("VinAudit", () => {
  afterEach(() => { delete process.env.VINAUDIT_API_KEY; });

  it("does nothing without a key", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await fetchVinAuditValue(VIN_A, 100000, fetchImpl)).toBeNull();
    expect(called).toBe(false);
  });

  it("parses a successful value and turns it into comparables centred on the average", async () => {
    process.env.VINAUDIT_API_KEY = "test";
    const fetchImpl = json({ success: true, vehicle: "2005 Toyota Corolla LE", mileage: 121349, count: 120, mean: 7044, certainty: 99, prices: { average: 7044, below: 5768, above: 8320 } });
    const value = await fetchVinAuditValue(VIN_A, 121349, fetchImpl);
    expect(value).toMatchObject({ count: 120, mean: 7044, below: 5768, above: 8320 });
    const comps = vinAuditComparables(value!);
    expect(comps.map((c) => c.price)).toEqual([5768, 7044, 7044, 8320]);
    expect(comps.every((c) => c.source === "vinaudit" && c.sold === false)).toBe(true);

    // The engine lands on the average, less its usual allowance for listing prices.
    const rec = analyzeDeal({ category: "vehicle", title: "2005 Toyota Corolla LE", askingPrice: 7500, condition: "good", comparables: comps, riskSignals: [], requiredFieldsPresent: 0.9, photoQuality: 0.6 });
    expect(rec.fairMarketValue).toBeGreaterThan(5000);
    expect(rec.fairMarketValue).toBeLessThanOrEqual(7044);
  });

  it("returns null on failure or an unsuccessful answer", async () => {
    process.env.VINAUDIT_API_KEY = "test";
    expect(await fetchVinAuditValue(VIN_A, null, json({ success: false }))).toBeNull();
    expect(await fetchVinAuditValue(VIN_A, null, json({}, 503))).toBeNull();
    const throws = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await fetchVinAuditValue(VIN_A, null, throws)).toBeNull();
  });
});
