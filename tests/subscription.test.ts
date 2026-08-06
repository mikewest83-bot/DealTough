import { describe, expect, it, vi, beforeEach } from "vitest";

// Deliberately a separate fake from credits.test.ts. That one models the
// array-form $transaction by returning deferred `{ apply }` descriptors; the
// subscription lifecycle functions call user.update directly, so they need a
// fake that mutates immediately.
type FakeUser = {
  id: string;
  stripeSubscriptionId: string | null;
  plan: string;
  subscriptionStatus: string;
  monthlyAllowance: number;
  monthlyUsage: number;
};

function makeFakePrisma() {
  const users = new Map<string, FakeUser>();

  return {
    users,
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return users.get(where.id) ?? null;
        if (where.stripeSubscriptionId) {
          return (
            [...users.values()].find((u) => u.stripeSubscriptionId === where.stripeSubscriptionId) ??
            null
          );
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const user = users.get(where.id);
        if (!user) throw new Error("no such user");
        Object.assign(user, data);
        return user;
      }),
    },
  };
}

const fakePrisma = makeFakePrisma();
vi.mock("../src/db.js", () => ({ getPrisma: () => fakePrisma }));

function seed(overrides: Partial<FakeUser> = {}): FakeUser {
  const user: FakeUser = {
    id: "u1",
    stripeSubscriptionId: "sub_123",
    plan: "plus",
    subscriptionStatus: "active",
    monthlyAllowance: 25,
    monthlyUsage: 7,
    ...overrides,
  };
  fakePrisma.users.set(user.id, user);
  return user;
}

describe("suspendForFailedPayment", () => {
  beforeEach(() => {
    fakePrisma.users.clear();
    fakePrisma.user.update.mockClear();
    fakePrisma.user.findUnique.mockClear();
  });

  it("drops a subscriber to the free allowance immediately", async () => {
    seed();
    const { suspendForFailedPayment } = await import("../src/billing.js");

    await suspendForFailedPayment("sub_123");

    const user = fakePrisma.users.get("u1")!;
    expect(user.subscriptionStatus).toBe("past_due");
    expect(user.monthlyAllowance).toBe(2);
  });

  it("leaves the subscription in place so a retry can restore it", async () => {
    seed();
    const { suspendForFailedPayment } = await import("../src/billing.js");

    await suspendForFailedPayment("sub_123");

    const user = fakePrisma.users.get("u1")!;
    expect(user.stripeSubscriptionId).toBe("sub_123");
    expect(user.plan).toBe("plus");
  });

  it("ignores an unknown subscription", async () => {
    const { suspendForFailedPayment } = await import("../src/billing.js");
    await expect(suspendForFailedPayment("sub_nope")).resolves.toBeUndefined();
  });
});

describe("restoreAfterPayment", () => {
  beforeEach(() => {
    fakePrisma.users.clear();
    fakePrisma.user.update.mockClear();
    fakePrisma.user.findUnique.mockClear();
  });

  it("restores a past_due account to the Plus allowance", async () => {
    seed({ subscriptionStatus: "past_due", monthlyAllowance: 2 });
    const { restoreAfterPayment } = await import("../src/billing.js");

    await restoreAfterPayment("sub_123");

    const user = fakePrisma.users.get("u1")!;
    expect(user.subscriptionStatus).toBe("active");
    expect(user.monthlyAllowance).toBe(25);
  });

  // Every successful renewal fires this event. Acting on an already-active
  // account would reset the usage window mid-cycle and hand out free analyses.
  it("does not touch an account that is already active", async () => {
    seed({ monthlyUsage: 7 });
    const { restoreAfterPayment } = await import("../src/billing.js");

    await restoreAfterPayment("sub_123");

    expect(fakePrisma.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" } }),
    );
    expect(fakePrisma.users.get("u1")!.monthlyUsage).toBe(7);
  });

  it("ignores an unknown subscription", async () => {
    const { restoreAfterPayment } = await import("../src/billing.js");
    await expect(restoreAfterPayment("sub_nope")).resolves.toBeUndefined();
  });
});

describe("subscriptionIdFromInvoice", () => {
  it("reads the current parent.subscription_details shape", async () => {
    const { subscriptionIdFromInvoice } = await import("../src/billing.js");
    const invoice = { parent: { subscription_details: { subscription: "sub_new" } } } as any;
    expect(subscriptionIdFromInvoice(invoice)).toBe("sub_new");
  });

  it("still reads the legacy top-level subscription field", async () => {
    const { subscriptionIdFromInvoice } = await import("../src/billing.js");
    expect(subscriptionIdFromInvoice({ subscription: "sub_old" } as any)).toBe("sub_old");
  });

  it("accepts an expanded subscription object in either position", async () => {
    const { subscriptionIdFromInvoice } = await import("../src/billing.js");
    expect(subscriptionIdFromInvoice({ subscription: { id: "sub_exp" } } as any)).toBe("sub_exp");
    expect(
      subscriptionIdFromInvoice({
        parent: { subscription_details: { subscription: { id: "sub_exp2" } } },
      } as any),
    ).toBe("sub_exp2");
  });

  // A one-off invoice has no subscription at all — the caller must skip it
  // rather than look up `null` and suspend an unrelated account.
  it("returns null when the invoice has no subscription", async () => {
    const { subscriptionIdFromInvoice } = await import("../src/billing.js");
    expect(subscriptionIdFromInvoice({} as any)).toBeNull();
  });
});
