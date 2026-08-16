import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Set before importing the app: the auth and persistence routes branch on
// these at module load and on every request.
process.env.JWT_SECRET = "test-only-secret";
process.env.DATABASE_URL = "postgresql://test/test";

// A stand-in for Prisma that records what it was asked for. The point of
// these tests is the authorization boundary — which `where` clause reaches
// the database — not the database itself.
const prisma = vi.hoisted(() => ({
  deal: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../src/db.js", () => ({ getPrisma: () => prisma }));

const { app } = await import("../src/app.js");
const { signSession } = await import("../src/auth.js");

let server: Server;
let baseUrl: string;
let sessionCookie: string;

const OWNER_ID = "user_owner";

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sessionCookie = `session=${await signSession(OWNER_ID)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
});

function get(path: string, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("health", () => {
  it("reports the engine version", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, engineVersion: "DTE-1.1" });
  });
});

// Express 4 does not catch a throw from an async handler. Without a try/catch
// the rejection escapes, nothing ever writes to the response, and the browser
// spins until it times out -- which is how a "crypto is not defined" error on
// an old Node runtime showed up in production as a sign-in that hung for
// minutes instead of an error anyone could see. These assert that an internal
// failure ends the request.
describe("auth failures answer instead of hanging", () => {
  it("answers 500 when sign-in hits an internal error", async () => {
    prisma.user.findUnique.mockRejectedValueOnce(new Error("crypto is not defined"));
    const res = await post("/api/auth/login", { email: "a@b.com", password: "password123" });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toHaveProperty("error");
  });

  it("answers 500 when registration hits an internal error", async () => {
    prisma.user.findUnique.mockRejectedValueOnce(new Error("connection lost"));
    const res = await post("/api/auth/register", { email: "a@b.com", password: "password123" });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toHaveProperty("error");
  });

  it("answers 500 when the account lookup hits an internal error", async () => {
    prisma.user.findUnique.mockRejectedValueOnce(new Error("connection lost"));
    const res = await get("/api/auth/me", sessionCookie);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toHaveProperty("error");
  });

  it("still rejects bad credentials with 401, not 500", async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    const res = await post("/api/auth/login", { email: "a@b.com", password: "password123" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/deals/analyze", () => {
  it("scores a well-formed deal", async () => {
    const res = await post("/api/v1/deals/analyze", {
      category: "electronics",
      title: "Sony WH-1000XM5",
      askingPrice: 200,
      condition: "good",
      comparables: [{ price: 280 }, { price: 300 }, { price: 265 }],
    });

    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.engineVersion).toBe("DTE-1.1");
    expect(report.dealScore).toBeGreaterThan(0);
    expect(report.fairMarketValue).toBeGreaterThan(0);
  });

  it("rejects a deal with no title", async () => {
    const res = await post("/api/v1/deals/analyze", {
      category: "electronics",
      askingPrice: 200,
      comparables: [],
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "title is required" });
  });

  it("rejects a non-positive asking price", async () => {
    const res = await post("/api/v1/deals/analyze", {
      category: "tools",
      title: "Drill",
      askingPrice: 0,
      comparables: [],
    });

    expect(res.status).toBe(400);
  });
});

describe("history routes require a session", () => {
  it("rejects an anonymous list request", async () => {
    const res = await get("/api/v1/deals");
    expect(res.status).toBe(401);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  it("rejects an anonymous single-deal request", async () => {
    const res = await get("/api/v1/deals/deal_123");
    expect(res.status).toBe(401);
    expect(prisma.deal.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a forged session cookie", async () => {
    const res = await get("/api/v1/deals", "session=not.a.real.jwt");
    expect(res.status).toBe(401);
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });
});

describe("history routes are scoped to the signed-in account", () => {
  it("filters the list by the session's user id", async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await get("/api/v1/deals?limit=5", sessionCookie);

    expect(res.status).toBe(200);
    expect(prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER_ID }, take: 5 }),
    );
  });

  it("caps an oversized limit rather than passing it through", async () => {
    prisma.deal.findMany.mockResolvedValue([]);

    await get("/api/v1/deals?limit=100000", sessionCookie);

    expect(prisma.deal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });

  it("looks a single deal up by id AND owner, never by id alone", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "deal_123", userId: OWNER_ID });

    const res = await get("/api/v1/deals/deal_123", sessionCookie);

    expect(res.status).toBe(200);
    expect(prisma.deal.findFirst).toHaveBeenCalledWith({
      where: { id: "deal_123", userId: OWNER_ID },
    });
  });

  it("404s on another account's deal instead of leaking its existence", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);

    const res = await get("/api/v1/deals/someone_elses_deal", sessionCookie);

    expect(res.status).toBe(404);
  });
});

describe("share links", () => {
  it("refuses to share a deal the caller does not own", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);

    const res = await post("/api/v1/deals/deal_123/share", {}, sessionCookie);

    expect(res.status).toBe(404);
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });

  it("mints a share id scoped to the owner", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "deal_123", userId: OWNER_ID, shareId: null });
    prisma.deal.update.mockResolvedValue({});

    const res = await post("/api/v1/deals/deal_123/share", {}, sessionCookie);

    expect(res.status).toBe(200);
    expect(prisma.deal.findFirst).toHaveBeenCalledWith({
      where: { id: "deal_123", userId: OWNER_ID },
    });
    const body = await res.json();
    expect(body.shareId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(body.url).toContain(`/d/${body.shareId}`);
  });

  it("reuses an existing share id so an already-sent link keeps working", async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: "deal_123",
      userId: OWNER_ID,
      shareId: "existingShare",
    });

    const res = await post("/api/v1/deals/deal_123/share", {}, sessionCookie);

    await expect(res.json()).resolves.toMatchObject({ shareId: "existingShare" });
    expect(prisma.deal.update).not.toHaveBeenCalled();
  });

  it("requires a session to create a share link", async () => {
    const res = await post("/api/v1/deals/deal_123/share", {});
    expect(res.status).toBe(401);
    expect(prisma.deal.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/public/deals/:shareId", () => {
  const deal = {
    id: "deal_123",
    userId: OWNER_ID,
    shareId: "abc123",
    title: "2019 Ford F-150 XLT",
    category: "vehicle",
    askingPrice: 28000,
    condition: "good",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    recommendation: { dealScore: 81 },
    rawListingText: "Call me at 555-0100, 12 Elm St",
    source: "from-listing",
  };

  it("serves a shared report without a session", async () => {
    prisma.deal.findUnique.mockResolvedValue(deal);

    const res = await get("/api/v1/public/deals/abc123");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("2019 Ford F-150 XLT");
    expect(body.recommendation).toEqual({ dealScore: 81 });
  });

  it("never exposes the owner or the raw listing text", async () => {
    prisma.deal.findUnique.mockResolvedValue(deal);

    const body = await (await get("/api/v1/public/deals/abc123")).json();

    expect(body).not.toHaveProperty("rawListingText");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("id");
    expect(JSON.stringify(body)).not.toContain("555-0100");
  });

  it("404s for an unshared or revoked id", async () => {
    prisma.deal.findUnique.mockResolvedValue(null);

    const res = await get("/api/v1/public/deals/revoked");

    expect(res.status).toBe(404);
  });
});

describe("billing input validation", () => {
  it("rejects an unknown credit pack before touching Stripe", async () => {
    const res = await post("/api/billing/checkout", { packId: "free-money" }, sessionCookie);
    // 400 when Stripe is configured, 503 when it isn't — either way the
    // bogus pack never reaches a charge.
    expect([400, 503]).toContain(res.status);
  });

  it("requires a session to start a checkout", async () => {
    const res = await post("/api/billing/checkout", { packId: "starter" });
    expect(res.status).toBe(401);
  });
});

// Sending a Host header through fetch is unreliable (undici treats it as
// forbidden), so these go through node:http, which sends exactly what it is
// given and does not follow the redirect.
function rawRequest(method: string, path: string, host: string) {
  return new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { host } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode!, location: res.headers.location });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("canonical host", () => {
  it("redirects a www page request to the apex, keeping the path and query", async () => {
    const res = await rawRequest("GET", "/d/abc123?ref=email", "www.dealtoughai.com");
    expect(res.status).toBe(301);
    expect(res.location).toBe("http://dealtoughai.com/d/abc123?ref=email");
  });

  // Stripe does not follow redirects. If the webhook ever arrives on www it
  // has to be handled, not bounced, or payments go silently unfulfilled --
  // which is the exact failure a wrong webhook URL already caused once.
  it("does not redirect a POST", async () => {
    const res = await rawRequest("POST", "/api/billing/webhook", "www.dealtoughai.com");
    expect(res.status).not.toBe(301);
  });

  it("leaves the apex alone", async () => {
    const res = await rawRequest("GET", "/health", "dealtoughai.com");
    expect(res.status).toBe(200);
  });

  // The Railway domain stays live and must keep serving, not redirect.
  it("leaves a non-www host alone", async () => {
    const res = await rawRequest("GET", "/health", "dealtough-production.up.railway.app");
    expect(res.status).toBe(200);
  });
});

// Kept last: the limiter's bucket is per-process and per-IP, so these
// requests would otherwise count against the other tests.
describe("rate limiting on the paid route", () => {
  it("cuts off a burst on /api/v1/deals/from-listing", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await post("/api/v1/deals/from-listing", { rawText: "x" }, sessionCookie);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 6)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });
});
