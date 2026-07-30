import { describe, expect, it, vi, beforeEach } from "vitest";

const constructEventMock = vi.fn();

vi.mock("stripe", () => ({
  default: class Stripe {
    webhooks = { constructEvent: constructEventMock };
  },
}));

describe("verifyWebhookEvent", () => {
  beforeEach(() => {
    constructEventMock.mockReset();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
  });

  it("returns the parsed event when the signature is valid", async () => {
    const fakeEvent = { type: "checkout.session.completed", data: { object: {} } };
    constructEventMock.mockReturnValue(fakeEvent);

    const { verifyWebhookEvent } = await import("../src/billing.js");
    const result = verifyWebhookEvent(Buffer.from("{}"), "sig123");

    expect(result).toBe(fakeEvent);
    expect(constructEventMock).toHaveBeenCalledWith(expect.any(Buffer), "sig123", "whsec_x");
  });

  it("throws when the signature is invalid, without touching anything else", async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const { verifyWebhookEvent } = await import("../src/billing.js");
    expect(() => verifyWebhookEvent(Buffer.from("{}"), "bad")).toThrow("bad signature");
  });
});
