import Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { env } from "./env.js";
import { getPrisma } from "./db.js";

export interface CreditPack {
  id: string;
  credits: number;
  priceCents: number;
  label: string;
}

// One pack, deliberately. The web UI only ever rendered `creditPacks[0]`, so
// the 50-pack was listed by the API and unreachable from the product.
export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack_10", credits: 10, priceCents: 400, label: "10 credits — $4" },
];

export const SIGNUP_BONUS_CREDITS = 2;

export const FREE_MONTHLY_ALLOWANCE = 2;
export const PLUS_MONTHLY_ALLOWANCE = 25;
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export const isPlusConfigured = (): boolean => Boolean(process.env.STRIPE_PLUS_PRICE_ID);

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(env.stripeSecretKey(), { apiVersion: "2026-07-29.dahlia" });
  }
  return stripeClient;
}

export function verifyWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
  return getStripe().webhooks.constructEvent(payload, signature, env.stripeWebhookSecret());
}

export async function createCheckoutSession(
  userId: string,
  packId: string,
  baseUrl: string,
): Promise<string> {
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new Error("Unknown credit pack");

  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    customer: await getOrCreateCustomer(userId),
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: pack.priceCents,
          product_data: { name: `DealTough — ${pack.label}` },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/?checkout=success`,
    cancel_url: `${baseUrl}/?checkout=cancel`,
    metadata: { userId, packId, credits: String(pack.credits) },
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

// Reuse one Stripe customer per account so subscriptions and one-off credit
// purchases show up under a single record.
async function getOrCreateCustomer(userId: string): Promise<string> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Account not found");
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await getStripe().customers.create({
    email: user.email,
    metadata: { dealtoughUserId: userId },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

export async function createSubscriptionCheckout(
  userId: string,
  baseUrl: string,
): Promise<string> {
  const priceId = process.env.STRIPE_PLUS_PRICE_ID;
  if (!priceId) throw new Error("The Plus price ID is not configured");

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: await getOrCreateCustomer(userId),
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/?checkout=success&plan=plus`,
    cancel_url: `${baseUrl}/?checkout=cancel`,
    client_reference_id: userId,
    metadata: { userId, purchaseType: "plus" },
    subscription_data: { metadata: { userId, purchaseType: "plus" } },
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

export async function activatePlus(
  userId: string,
  subscriptionId: string | null,
): Promise<void> {
  await getPrisma().user.update({
    where: { id: userId },
    data: {
      plan: "plus",
      subscriptionStatus: "active",
      monthlyAllowance: PLUS_MONTHLY_ALLOWANCE,
      monthlyUsage: 0,
      monthlyResetAt: new Date(Date.now() + MONTH_MS),
      stripeSubscriptionId: subscriptionId,
    },
  });
}

// Stripe reports the cancellation against the subscription, not the user, so
// look the account up by the ID we stored at activation.
export async function deactivatePlus(subscriptionId: string): Promise<void> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { stripeSubscriptionId: subscriptionId },
  });
  if (!user) return;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      plan: "free",
      subscriptionStatus: "canceled",
      monthlyAllowance: FREE_MONTHLY_ALLOWANCE,
      stripeSubscriptionId: null,
    },
  });
}

// A renewal that fails to collect must stop granting Plus value immediately.
// Stripe's dunning cycle retries for weeks before it gives up and fires
// `customer.subscription.deleted`, and until this existed that whole window
// was a free month of Plus. The subscription and plan are left in place so a
// successful retry can restore the account without a new checkout.
export async function suspendForFailedPayment(subscriptionId: string): Promise<void> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { stripeSubscriptionId: subscriptionId },
  });
  if (!user) return;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: "past_due",
      monthlyAllowance: FREE_MONTHLY_ALLOWANCE,
    },
  });
}

// The other half of the above: without it, anyone whose card failed once would
// sit at the free allowance forever while still being billed. Deliberately
// only acts on a past_due account — every renewal fires this event, and
// resetting usage on each one would hand out extra analyses mid-window.
export async function restoreAfterPayment(subscriptionId: string): Promise<void> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { stripeSubscriptionId: subscriptionId },
  });
  if (!user || user.subscriptionStatus !== "past_due") return;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: "active",
      monthlyAllowance: PLUS_MONTHLY_ALLOWANCE,
    },
  });
}

// Stripe moved the subscription reference out of `invoice.subscription` and
// into `invoice.parent.subscription_details.subscription` in the 2025 API
// versions. This account is on 2026-06-24.dahlia, but read both shapes so a
// version pin or rollback doesn't silently stop resolving the subscription.
export function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
  if (typeof legacy === "string") return legacy;
  if (legacy && typeof legacy === "object") return legacy.id;

  const current = invoice.parent?.subscription_details?.subscription;
  if (typeof current === "string") return current;
  if (current && typeof current === "object") return current.id;

  return null;
}

// Idempotent via the unique constraint on stripeSessionId, not application
// logic — Stripe can and does redeliver the same event.
export async function fulfillCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    throw new Error(`Checkout session ${session.id} is missing a userId`);
  }

  if (session.mode === "subscription") {
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;
    await activatePlus(userId, subscriptionId);
    return;
  }

  const credits = Number(session.metadata?.credits);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error(`Checkout session ${session.id} is missing valid metadata`);
  }

  const prisma = getPrisma();
  try {
    await prisma.$transaction([
      prisma.creditTransaction.create({
        data: { userId, delta: credits, reason: "purchase", stripeSessionId: session.id },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: credits } },
      }),
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return; // already fulfilled — Stripe redelivered the event
    }
    throw error;
  }
}

export type AnalysisCharge = "allowance" | "credit" | null;

// The plan's monthly allowance is spent before purchased credits, so credits
// never evaporate while a free analysis was still available. One transaction
// so concurrent requests can't both claim the last one.
export async function consumeAnalysis(userId: string): Promise<AnalysisCharge> {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx): Promise<AnalysisCharge> => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) return null;

    // Roll the window forward first — someone returning after a long gap
    // shouldn't be judged against a stale count.
    const expired = user.monthlyResetAt.getTime() <= Date.now();
    const monthlyUsage = expired ? 0 : user.monthlyUsage;
    const monthlyResetAt = expired ? new Date(Date.now() + MONTH_MS) : user.monthlyResetAt;

    if (monthlyUsage < user.monthlyAllowance) {
      await tx.user.update({
        where: { id: userId },
        data: { monthlyUsage: monthlyUsage + 1, monthlyResetAt },
      });
      return "allowance";
    }

    if (user.creditBalance > 0) {
      await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { decrement: 1 }, monthlyUsage, monthlyResetAt },
      });
      await tx.creditTransaction.create({
        data: { userId, delta: -1, reason: "consumption" },
      });
      return "credit";
    }

    return null;
  });
}

// Extraction failed, so the user got nothing — hand the charge back. Best
// effort: a failed refund must not mask the original error.
export async function refundAnalysis(userId: string, charge: AnalysisCharge): Promise<void> {
  if (!charge) return;
  const prisma = getPrisma();
  try {
    if (charge === "allowance") {
      await prisma.user.update({
        where: { id: userId },
        data: { monthlyUsage: { decrement: 1 } },
      });
      return;
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: 1 } },
      }),
      prisma.creditTransaction.create({
        data: { userId, delta: 1, reason: "refund" },
      }),
    ]);
  } catch (error) {
    console.error("Failed to refund analysis:", error);
  }
}

// Atomic conditional decrement — safe under two concurrent requests spending
// the same user's last credit.
export async function spendOneCredit(userId: string): Promise<boolean> {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: { id: userId, creditBalance: { gte: 1 } },
      data: { creditBalance: { decrement: 1 } },
    });
    if (result.count === 0) return false;
    await tx.creditTransaction.create({
      data: { userId, delta: -1, reason: "consumption" },
    });
    return true;
  });
}
