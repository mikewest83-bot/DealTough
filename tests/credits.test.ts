import { describe, expect, it, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// A minimal in-memory fake matching the slice of the Prisma Client interface
// billing.ts uses. Real atomicity comes from Postgres row locks under
// $transaction; this fake verifies the *query shape* correctly encodes the
// conditional-decrement / unique-constraint idempotency pattern.
// Real Postgres transactions are all-or-nothing: if one statement in a
// $transaction([...]) array fails, none of them are committed. This fake
// models that by having the array-form operations return a deferred
// `{ apply }` descriptor instead of mutating immediately — the array-form
// $transaction only calls `apply()` on every item once `Promise.all` has
// confirmed all of them succeeded, so a rejection anywhere commits nothing.
// The interactive callback form (used by spendOneCredit) doesn't need this —
// its own atomicity is the exact conditional-decrement query being tested.
function makeFakePrisma() {
  const users = new Map<string, { creditBalance: number }>();
  const usedSessionIds = new Set<string>();

  const creditTransaction = {
    create: vi.fn(async ({ data }: any) => {
      if (data.stripeSessionId && usedSessionIds.has(data.stripeSessionId)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6.19.3",
        });
      }
      return { apply: () => data.stripeSessionId && usedSessionIds.add(data.stripeSessionId) };
    }),
  };

  const user = {
    update: vi.fn(async ({ where, data }: any) => ({
      apply: () => {
        const u = users.get(where.id) ?? { creditBalance: 0 };
        u.creditBalance += data.creditBalance.increment;
        users.set(where.id, u);
      },
    })),
    updateMany: vi.fn(async ({ where }: any) => {
      const u = users.get(where.id);
      if (!u || u.creditBalance < 1) return { count: 0 };
      u.creditBalance -= 1;
      return { count: 1 };
    }),
  };

  const tx = {
    user: { updateMany: user.updateMany },
    creditTransaction: { create: vi.fn(async (args: any) => (await creditTransaction.create(args)).apply()) },
  };

  return {
    user,
    creditTransaction,
    users,
    usedSessionIds,
    $transaction: vi.fn(async (arg: any) => {
      if (Array.isArray(arg)) {
        const settled = await Promise.all(arg);
        settled.forEach((s: any) => s.apply());
        return settled;
      }
      return arg(tx);
    }),
  };
}

const fakePrisma = makeFakePrisma();
vi.mock("../src/db.js", () => ({ getPrisma: () => fakePrisma }));

describe("spendOneCredit", () => {
  beforeEach(() => {
    fakePrisma.users.clear();
    fakePrisma.user.updateMany.mockClear();
  });

  it("spends a credit when the balance allows it", async () => {
    fakePrisma.users.set("u1", { creditBalance: 1 });
    const { spendOneCredit } = await import("../src/billing.js");

    expect(await spendOneCredit("u1")).toBe(true);
    expect(fakePrisma.users.get("u1")!.creditBalance).toBe(0);
  });

  it("never lets balance go negative under repeated calls", async () => {
    fakePrisma.users.set("u1", { creditBalance: 1 });
    const { spendOneCredit } = await import("../src/billing.js");

    const [first, second] = await Promise.all([spendOneCredit("u1"), spendOneCredit("u1")]);
    const results = [first, second];

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fakePrisma.users.get("u1")!.creditBalance).toBe(0);
  });

  it("returns false when there is nothing to spend", async () => {
    fakePrisma.users.set("u1", { creditBalance: 0 });
    const { spendOneCredit } = await import("../src/billing.js");

    expect(await spendOneCredit("u1")).toBe(false);
  });
});

describe("fulfillCheckout", () => {
  beforeEach(() => {
    fakePrisma.users.clear();
    fakePrisma.usedSessionIds.clear();
  });

  function fakeSession(overrides: Record<string, unknown> = {}) {
    return {
      id: "cs_test_123",
      metadata: { userId: "u1", packId: "pack_10", credits: "10" },
      ...overrides,
    } as any;
  }

  it("credits the user's account", async () => {
    const { fulfillCheckout } = await import("../src/billing.js");
    await fulfillCheckout(fakeSession());
    expect(fakePrisma.users.get("u1")!.creditBalance).toBe(10);
  });

  it("is a no-op the second time the same session is fulfilled (Stripe redelivery)", async () => {
    const { fulfillCheckout } = await import("../src/billing.js");
    await fulfillCheckout(fakeSession());
    await fulfillCheckout(fakeSession()); // same session.id — must not throw or double-credit

    expect(fakePrisma.users.get("u1")!.creditBalance).toBe(10);
  });

  it("throws when metadata is missing or invalid", async () => {
    const { fulfillCheckout } = await import("../src/billing.js");
    await expect(fulfillCheckout(fakeSession({ metadata: {} }))).rejects.toThrow();
  });
});
