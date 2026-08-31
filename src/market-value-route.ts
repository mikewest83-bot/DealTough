import type { Application, Request, Response } from "express";
import { analyzeDeal } from "./engine.js";
import { fetchComparables } from "./ebay.js";
import type { DealCategory, DealInput } from "./types.js";
import { isEbayConfigured } from "./env.js";

const VALID_CATEGORIES: DealCategory[] = [
  "vehicle",
  "electronics",
  "tools",
  "furniture",
  "outdoor_equipment",
];

// Optional shared secret for the first-party callers (Mike AI today). Left
// unset the route behaves exactly as it does now, so shipping this cannot
// break anything on its own - enforcement starts only when the variable is
// set on both sides. DoerToughMoney is deliberately unaffected: it calls
// /api/v1/deals/analyze, which stays open because that analysis is free
// inside DoerToughMoney by design.
const SERVICE_TOKEN = String(process.env.MARKET_VALUE_TOKEN || "").trim();

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;

function rateLimit(req: Request, res: Response): boolean {
  const key = req.ip || "unknown";
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS) {
    res.status(429).json({ error: "Too many market-value requests — try again shortly" });
    return false;
  }
  return true;
}

export function installMarketValueRoute(app: Application): void {
  app.post("/api/v1/market-value", async (req, res) => {
    if (SERVICE_TOKEN && req.get("x-dealtough-token") !== SERVICE_TOKEN) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!rateLimit(req, res)) return;
    if (!isEbayConfigured()) {
      res.status(503).json({ error: "Market-value comparables are not configured" });
      return;
    }

    const category = String(req.body?.category || "").trim().toLowerCase();
    const title = String(req.body?.title || "").trim();
    const rawAskingPrice = req.body?.askingPrice;
    const hasAskingPrice = rawAskingPrice !== undefined && rawAskingPrice !== null && rawAskingPrice !== "";
    const askingPrice = hasAskingPrice ? Number(rawAskingPrice) : null;
    const condition = String(req.body?.condition || "unknown").trim().toLowerCase();
    const description = req.body?.description ? String(req.body.description) : undefined;

    if (!VALID_CATEGORIES.includes(category as DealCategory)) {
      res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}.` });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "title_required" });
      return;
    }
    if (askingPrice !== null && (!Number.isFinite(askingPrice) || askingPrice <= 0)) {
      res.status(400).json({ error: "askingPrice must be a positive number when supplied." });
      return;
    }

    try {
      const comparables = await fetchComparables({
        title,
        category: category as DealCategory,
        askingPrice: askingPrice ?? undefined,
        limit: 50,
      });

      // The deterministic engine requires an asking price, but fair market
      // value itself comes from the comparable set. When the user is asking
      // "what is this worth?" rather than "is this listing a good deal?",
      // use a neutral $1 anchor only for the engine's required input and return
      // the market-value fields, never the resulting deal score.
      const engineAskingPrice = askingPrice ?? 1;
      const input: DealInput = {
        category: category as DealCategory,
        title,
        askingPrice: engineAskingPrice,
        condition: ["new", "like_new", "good", "fair", "poor", "unknown"].includes(condition)
          ? condition as DealInput["condition"]
          : "unknown",
        description,
        comparables,
        riskSignals: [],
        requiredFieldsPresent: 0,
        photoQuality: 0,
      };

      const recommendation = analyzeDeal(input);
      res.status(200).json({
        title,
        category,
        askingPrice,
        fairMarketValue: recommendation.fairMarketValue,
        valuationBasis: recommendation.valuationBasis,
        confidencePercent: recommendation.confidencePercent,
        comparablesUsed: comparables.length,
        soldComparables: comparables.filter((c) => c.sold).length,
        activeComparables: comparables.filter((c) => !c.sold).length,
        assumptions: recommendation.assumptions,
        engineVersion: recommendation.engineVersion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market-value lookup failed";
      res.status(502).json({ error: message });
    }
  });
}
