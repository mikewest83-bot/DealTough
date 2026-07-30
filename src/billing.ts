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

export const CREDIT_PACKS: CreditPack[] = [
  { id: "pack_10", credits: 10, priceCents: 500, label: "10 credits — $5" },
  { id: "pack_50", credits: 50, priceCents: 2000, label: "50 credits — $20" },
];

export const SIGNUP_BONUS_CREDITS = 2;

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

// Idempotent via the unique constraint on stripeSessionId, not application
// logic — Stripe can and does redeliver the same event.
export async function fulfillCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.userId;
  const credits = Number(session.metadata?.credits);
  if (!userId || !Number.isFinite(credits) || credits <= 0) {
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
