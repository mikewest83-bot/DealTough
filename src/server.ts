import express from "express";
import type { NextFunction, Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { analyzeDeal } from "./engine.js";
import type { Comparable, DealCategory, DealInput } from "./types.js";
import { isAnthropicConfigured, isAuthConfigured, isDbConfigured, isEbayConfigured, isStripeConfigured } from "./env.js";
import { extractListingFields, type ExtractPhoto } from "./extract.js";
import { fetchComparables } from "./ebay.js";
import { getPrisma } from "./db.js";
import {
  clearSessionCookie,
  getSessionUserId,
  hashPassword,
  requireAuth,
  setSessionCookie,
  signSession,
  verifyPassword,
} from "./auth.js";
import {
  CREDIT_PACKS,
  FREE_MONTHLY_ALLOWANCE,
  MONTH_MS,
  SIGNUP_BONUS_CREDITS,
  consumeAnalysis,
  createCheckoutSession,
  createSubscriptionCheckout,
  deactivatePlus,
  fulfillCheckout,
  isPlusConfigured,
  refundAnalysis,
  verifyWebhookEvent,
} from "./billing.js";

const VALID_CATEGORIES: DealCategory[] = [
  "vehicle",
  "electronics",
  "tools",
  "furniture",
  "outdoor_equipment",
];

function isValidCategory(value: unknown): value is DealCategory {
  return typeof value === "string" && (VALID_CATEGORIES as string[]).includes(value);
}

interface AccountUser {
  email: string;
  plan: string;
  monthlyUsage: number;
  monthlyAllowance: number;
  monthlyResetAt: Date;
  creditBalance: number;
  subscriptionStatus: string;
}

// One shape for every account response, so the UI can show what's left
// without a second round trip. Reports the rolled-forward usage rather than
// the stored one — otherwise a stale count reads as "0 remaining" until the
// next analysis rewrites it.
function accountSummary(user: AccountUser) {
  const monthlyUsage = user.monthlyResetAt.getTime() <= Date.now() ? 0 : user.monthlyUsage;
  return {
    email: user.email,
    plan: user.plan,
    monthlyUsage,
    monthlyAllowance: user.monthlyAllowance,
    analysesRemaining: Math.max(0, user.monthlyAllowance - monthlyUsage),
    creditBalance: user.creditBalance,
    subscriptionStatus: user.subscriptionStatus,
  };
}

// ── rate limiting ───────────────────────────────────────────────────────
// In-memory per-IP window; assumes a single instance, same tradeoff as the
// in-memory eBay token cache. Applied to the route that spends money.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.status(429).json({ error: "Too many requests — try again shortly" });
      return;
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

const app = express();
app.set("trust proxy", 1); // Railway edge proxy — makes req.ip the real client IP

// Must be registered BEFORE the global express.json() below — Stripe webhook
// signature verification needs the raw, unparsed body for this one route only.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!isStripeConfigured()) {
    res.status(503).json({ error: "Billing is not configured" });
    return;
  }
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = verifyWebhookEvent(req.body as Buffer, signature);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid signature";
    res.status(400).json({ error: message });
    return;
  }

  try {
    if (event.type === "checkout.session.completed") {
      await fulfillCheckout(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "customer.subscription.deleted") {
      // Covers cancellation and Stripe giving up after failed payments.
      await deactivatePlus((event.data.object as Stripe.Subscription).id);
    }
  } catch (error) {
    console.error("Webhook fulfillment failed:", error);
    // A non-2xx tells Stripe to retry, which is what we want for a
    // transient database failure.
    res.status(500).json({ error: "Webhook processing failed" });
    return;
  }

  res.status(200).json({ received: true });
});

app.use(express.json({ limit: "25mb" }));

// Web UI (public/index.html) at /; JSON health check moved to /health.
// The relative depth differs between `tsx src/server.ts` and the built
// dist/src/server.js, so probe instead of hardcoding one of them.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicPath =
  [
    path.resolve(currentDir, "../../public"),
    path.resolve(currentDir, "../public"),
    path.resolve(process.cwd(), "public"),
  ].find((candidate) => fs.existsSync(candidate)) ??
  path.resolve(process.cwd(), "public");

app.use(express.static(publicPath));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, engineVersion: "DTE-1.0" });
});

// ── auth ────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  if (!isAuthConfigured() || !isDbConfigured()) {
    res.status(503).json({ error: "Accounts are not configured" });
    return;
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email.includes("@") || password.length < 8) {
    res.status(400).json({ error: "A valid email and an 8+ character password are required" });
    return;
  }

  const prisma = getPrisma();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      creditBalance: SIGNUP_BONUS_CREDITS,
      monthlyAllowance: FREE_MONTHLY_ALLOWANCE,
      // Required by the schema — no default, so it must be set at creation.
      monthlyResetAt: new Date(Date.now() + MONTH_MS),
      transactions: {
        create: { delta: SIGNUP_BONUS_CREDITS, reason: "signup_bonus" },
      },
    },
  });

  const token = await signSession(user.id);
  setSessionCookie(res, token);
  res.status(201).json(accountSummary(user));
});

app.post("/api/auth/login", async (req, res) => {
  if (!isAuthConfigured() || !isDbConfigured()) {
    res.status(503).json({ error: "Accounts are not configured" });
    return;
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const user = await getPrisma().user.findUnique({ where: { email } });
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const token = await signSession(user.id);
  setSessionCookie(res, token);
  res.status(200).json(accountSummary(user));
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  if (!isAuthConfigured() || !isDbConfigured()) {
    res.status(503).json({ error: "Accounts are not configured" });
    return;
  }
  const userId = await getSessionUserId(req);
  const user = userId ? await getPrisma().user.findUnique({ where: { id: userId } }) : null;
  if (!user) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  res.status(200).json(accountSummary(user));
});

// ── billing ─────────────────────────────────────────────────────────────
app.get("/api/billing/packs", (_req, res) => {
  res.status(200).json({ packs: CREDIT_PACKS, plusAvailable: isPlusConfigured() });
});

app.post("/api/billing/subscribe", requireAuth, async (req, res) => {
  if (!isStripeConfigured() || !isPlusConfigured()) {
    res.status(503).json({ error: "Plus subscriptions are not configured" });
    return;
  }
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const url = await createSubscriptionCheckout(req.userId!, baseUrl);
    res.status(200).json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start checkout";
    res.status(502).json({ error: message });
  }
});

app.post("/api/billing/checkout", requireAuth, async (req, res) => {
  if (!isStripeConfigured()) {
    res.status(503).json({ error: "Billing is not configured" });
    return;
  }
  const packId = req.body?.packId;
  if (!CREDIT_PACKS.some((p) => p.id === packId)) {
    res.status(400).json({ error: "Unknown credit pack" });
    return;
  }
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const url = await createCheckoutSession(req.userId!, packId, baseUrl);
    res.status(200).json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start checkout";
    res.status(502).json({ error: message });
  }
});

app.post("/api/v1/deals/analyze", (req, res) => {
  try {
    const report = analyzeDeal(req.body);
    res.status(200).json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    res.status(400).json({ error: message });
  }
});

app.post("/api/v1/deals/from-listing", requireAuth, rateLimit(6, 60_000), async (req, res) => {
  if (!isAnthropicConfigured()) {
    res.status(503).json({ error: "Listing extraction is not configured" });
    return;
  }

  const rawText = req.body?.rawText;
  if (typeof rawText !== "string" || !rawText.trim()) {
    res.status(400).json({ error: "rawText is required" });
    return;
  }

  const photosInput = req.body?.photos;
  let photos: ExtractPhoto[] | undefined;
  if (photosInput !== undefined) {
    if (!Array.isArray(photosInput)) {
      res.status(400).json({ error: "photos must be an array" });
      return;
    }
    const validMediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    for (const photo of photosInput) {
      if (typeof photo?.base64 !== "string" || !validMediaTypes.has(photo?.mediaType)) {
        res.status(400).json({ error: "each photo needs base64 and a valid mediaType" });
        return;
      }
    }
    photos = photosInput as ExtractPhoto[];
  }

  const categoryOverride = req.body?.categoryOverride;
  if (categoryOverride !== undefined && !isValidCategory(categoryOverride)) {
    res.status(400).json({ error: "categoryOverride must be a valid category" });
    return;
  }

  // Spent right before the call that actually costs money — not contingent
  // on later steps (eBay comps, DB save) that already degrade gracefully.
  const charge = await consumeAnalysis(req.userId!);
  if (!charge) {
    res.status(402).json({
      error: "You've used every analysis on your plan — upgrade to Plus or buy a credit pack",
    });
    return;
  }

  const warnings: string[] = [];

  let extracted;
  try {
    extracted = await extractListingFields({ rawText, photos, categoryOverride });
  } catch (error) {
    // Nothing was produced, so the charge is handed back.
    await refundAnalysis(req.userId!, charge);
    const message = error instanceof Error ? error.message : "Extraction failed";
    res.status(502).json({ error: message });
    return;
  }

  const category = categoryOverride ?? extracted.category;
  if (!isValidCategory(category)) {
    await refundAnalysis(req.userId!, charge);
    res.status(422).json({ error: `Extracted an invalid category: ${String(category)}` });
    return;
  }

  let comparables: Comparable[] = [];
  let comparablesSource = "none";
  if (isEbayConfigured()) {
    try {
      comparables = await fetchComparables({ title: extracted.title, category });
      if (comparables.length) comparablesSource = "ebay_active";
      else warnings.push("eBay returned no comparable listings");
    } catch (error) {
      const message = error instanceof Error ? error.message : "eBay lookup failed";
      warnings.push(`eBay comparables unavailable: ${message}`);
    }
  } else {
    warnings.push("eBay comparables not configured — used askingPrice as provisional value");
  }

  const dealInput: DealInput = {
    category,
    title: extracted.title,
    askingPrice: extracted.askingPrice,
    condition: extracted.condition,
    description: extracted.description,
    sellerRating: extracted.sellerRating,
    sellerReviewCount: extracted.sellerReviewCount,
    comparables,
    riskSignals: extracted.riskSignals,
    requiredFieldsPresent: extracted.requiredFieldsPresent,
    photoQuality: extracted.photoQuality,
  };

  let recommendation;
  try {
    recommendation = analyzeDeal(dealInput);
  } catch (error) {
    await refundAnalysis(req.userId!, charge);
    const message = error instanceof Error ? error.message : "Invalid extracted input";
    res.status(422).json({ error: message });
    return;
  }

  let dealId: string | null = null;
  if (isDbConfigured()) {
    try {
      const deal = await getPrisma().deal.create({
        data: {
          title: dealInput.title,
          category: dealInput.category,
          askingPrice: dealInput.askingPrice,
          condition: dealInput.condition ?? null,
          recommendation: recommendation as unknown as object,
          source: "from-listing",
          rawListingText: rawText,
          userId: req.userId!,
        },
      });
      dealId = deal.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Persistence failed";
      warnings.push(`Result not persisted: ${message}`);
    }
  } else {
    warnings.push("Persistence not configured — result not saved");
  }

  res.status(200).json({
    dealId,
    extracted: {
      title: extracted.title,
      category: extracted.category,
      askingPrice: extracted.askingPrice,
      condition: extracted.condition,
      riskSignals: extracted.riskSignals,
      requiredFieldsPresent: extracted.requiredFieldsPresent,
      photoQuality: extracted.photoQuality,
    },
    comparablesSource,
    comparablesCount: comparables.length,
    recommendation,
    warnings,
  });
});

// Express 4 does not catch async throws — an unhandled rejection kills the
// process — so every await in these handlers stays inside try/catch.
// Both history routes are scoped to the signed-in account. Looking a deal up
// by id alone would hand any visitor every other user's listings.
app.get("/api/v1/deals/:id", requireAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Persistence is not configured" });
    return;
  }
  try {
    const deal = await getPrisma().deal.findFirst({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (!deal) {
      res.status(404).json({ error: "Deal not found" });
      return;
    }
    res.status(200).json(deal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database error";
    res.status(500).json({ error: message });
  }
});

app.get("/api/v1/deals", requireAuth, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Persistence is not configured" });
    return;
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const deals = await getPrisma().deal.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    res.status(200).json(deals);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database error";
    res.status(500).json({ error: message });
  }
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, "0.0.0.0", () => {
  console.log(`DealTough API listening on port ${port}`);
});
