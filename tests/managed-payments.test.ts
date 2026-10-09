import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ create: vi.fn(), find: vi.fn() }));
vi.mock("stripe", () => ({ default: class { checkout = { sessions: { create: f.create } }; } }));
vi.mock("@prisma/client", () => ({ Prisma: {} }));
vi.mock("../src/db.js", () => ({ getPrisma: () => ({ user: { findUnique: f.find } }) }));
vi.mock("../src/env.js", () => ({ env: { stripeSecretKey: () => "fixture" } }));
import { createCheckoutSession, createSubscriptionCheckout } from "../src/billing.js";

describe("Managed Payments checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.find.mockResolvedValue({ id: "u1", stripeCustomerId: "cus_fixture" });
    f.create.mockResolvedValue({ url: "https://checkout.stripe.com/fixture" });
    vi.stubEnv("STRIPE_MANAGED_PAYMENTS_ENABLED", "true");
    vi.stubEnv("STRIPE_CREDIT_PACK_TAX_CODE", "txcd_10105001");
    vi.stubEnv("STRIPE_PLUS_PRICE_ID", "price_fixture");
  });
  it("covers credit purchases without changing credits or price", async () => {
    await createCheckoutSession("u1", "pack_10", "https://example.test");
    const p = f.create.mock.calls[0][0];
    expect(p.managed_payments).toEqual({ enabled: true });
    expect(p.automatic_tax).toBeUndefined();
    expect(p.customer).toBe("cus_fixture");
    expect(p.line_items[0].price_data.unit_amount).toBe(400);
    expect(p.line_items[0].price_data.product_data.tax_code).toBe("txcd_10105001");
    expect(p.metadata.credits).toBe("10");
  });
  it("covers subscriptions and preserves entitlement metadata", async () => {
    await createSubscriptionCheckout("u1", "https://example.test");
    const p = f.create.mock.calls[0][0];
    expect(p.managed_payments).toEqual({ enabled: true });
    expect(p.line_items).toEqual([{ price: "price_fixture", quantity: 1 }]);
    expect(p.subscription_data.metadata).toEqual({ userId: "u1", purchaseType: "plus" });
  });
  it("blocks managed credit checkout until its tax classification is configured", async () => {
    vi.stubEnv("STRIPE_CREDIT_PACK_TAX_CODE", "");
    await expect(createCheckoutSession("u1", "pack_10", "https://example.test")).rejects.toThrow("tax classification");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("leaves existing checkout unchanged until activation", async () => {
    vi.stubEnv("STRIPE_MANAGED_PAYMENTS_ENABLED", "false");
    await createSubscriptionCheckout("u1", "https://example.test");
    expect(f.create.mock.calls[0][0].managed_payments).toBeUndefined();
  });
  it("does not silently retry outside Managed Payments on rejection", async () => {
    f.create.mockRejectedValueOnce(new Error("not eligible"));
    await expect(createSubscriptionCheckout("u1", "https://example.test")).rejects.toThrow("not eligible");
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});
