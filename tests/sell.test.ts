import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET = "test-only-secret";
process.env.DATABASE_URL = "postgresql://test/test";
process.env.ANTHROPIC_API_KEY = "test-key";

// Fake AI: returns whatever the current test queues up.
const ai = vi.hoisted(() => ({ next: "" as string }));
vi.mock("../src/extract.js", async (orig) => {
  const real = await orig<typeof import("../src/extract.js")>();
  return {
    ...real,
    getClient: () => ({
      messages: { create: async () => ({ content: [{ type: "text", text: ai.next }] }) },
    }),
  };
});
vi.mock("../src/db.js", () => ({ getPrisma: () => ({}) }));

const { niceRound, buildPricePlan, suggestReply, generateListing, LIST_PREMIUM, FLOOR_DISCOUNT } = await import("../src/sell.js");
const { app } = await import("../src/app.js");
const { signSession } = await import("../src/auth.js");

describe("niceRound", () => {
  it("rounds to the steps people list at", () => {
    expect(niceRound(87)).toBe(85);
    expect(niceRound(87, "up")).toBe(90);
    expect(niceRound(452, "down")).toBe(450);
    expect(niceRound(12345)).toBe(12300);
    expect(niceRound(0)).toBe(0);
  });
});

describe("buildPricePlan", () => {
  const comps = [300, 320, 310, 290, 330, 305].map((price) => ({ price, similarity: 1, sold: true }));

  it("lists above expected value and holds a floor below it, from comparables only", () => {
    const plan = buildPricePlan("electronics", "good", comps, "ebay_sold");
    expect(plan.available).toBe(true);
    const fmv = plan.fairMarketValue!;
    expect(plan.listAt).toBeGreaterThanOrEqual(fmv * (1 + LIST_PREMIUM) - 0.01);
    expect(plan.lowestToAccept).toBeLessThanOrEqual(fmv * (1 - FLOOR_DISCOUNT) + 0.01);
    expect(plan.listAt!).toBeGreaterThan(plan.expectAround!);
    expect(plan.expectAround!).toBeGreaterThan(plan.lowestToAccept!);
  });

  it("gives no prices when there is no evidence", () => {
    const plan = buildPricePlan("tools", "good", [], "none");
    expect(plan.available).toBe(false);
    expect(plan.listAt).toBeUndefined();
    expect(plan.notes[0]).toMatch(/couldn't find enough comparable/i);
  });
});

describe("generateListing", () => {
  it("keeps the seller's category and a valid cover photo index", async () => {
    ai.next = JSON.stringify({
      category: "electronics", itemName: "DeWalt drill", searchQuery: "DeWalt DCD771", roughValueEstimate: 70,
      condition: "good", conditionSummary: "Works, light wear", flaws: ["scuffed grip"], included: ["charger"],
      specs: [], headline: "DeWalt 20V drill kit", description: "Works great.", coverPhotoIndex: 9, missingShots: [],
    });
    const out = await generateListing([{ base64: "x", mediaType: "image/jpeg" }, { base64: "y", mediaType: "image/jpeg" }], "", "tools");
    expect(out.category).toBe("tools");
    expect(out.coverPhotoIndex).toBe(1);
  });
});

describe("suggestReply", () => {
  it("never leaks the seller's lowest price", async () => {
    ai.next = JSON.stringify({ intent: "offer", offerAmount: 300, reply: "I can't do 300, but I could do $450.", tipForSeller: "Counter." });
    const out = await suggestReply({ itemName: "Aeron chair", listPrice: 550, lowestToAccept: 450, buyerMessage: "Would you take 300?" });
    expect(out.reply).not.toMatch(/450/);
    expect(out.tipForSeller).toMatch(/replaced/);
  });

  it("allows the number when the buyer offered it", async () => {
    ai.next = JSON.stringify({ intent: "offer", offerAmount: 450, reply: "Deal at $450. When can you come by?", tipForSeller: "Accept." });
    const out = await suggestReply({ itemName: "Aeron chair", listPrice: 550, lowestToAccept: 450, buyerMessage: "Would you take $450?" });
    expect(out.reply).toMatch(/450/);
  });
});

describe("sell routes", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;
  beforeAll(async () => {
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cookie = `session=${await signSession("user_1")}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) }, body: JSON.stringify(body) });

  it("requires sign-in", async () => {
    expect((await post("/api/v1/listings/create", {}, false)).status).toBe(401);
    expect((await post("/api/v1/listings/reply", {}, false)).status).toBe(401);
  });

  it("rejects bad input before charging anything", async () => {
    expect((await post("/api/v1/listings/create", { photos: [] })).status).toBe(400);
    const nine = Array.from({ length: 9 }, () => ({ base64: "x", mediaType: "image/jpeg" }));
    expect((await post("/api/v1/listings/create", { photos: nine })).status).toBe(400);
    expect((await post("/api/v1/listings/create", { photos: [{ base64: "x", mediaType: "image/heic" }] })).status).toBe(400);
    expect((await post("/api/v1/listings/reply", { itemName: "x" })).status).toBe(400);
  });
});
