import type { Application, Request, Response } from "express";
import { analyzeDeal } from "./engine.js";
import { fetchComparables } from "./ebay.js";
import type { Comparable, CostItem, DealCategory, DealInput } from "./types.js";
import { isEbayConfigured } from "./env.js";

const VALID_CATEGORIES: DealCategory[] = [
  "vehicle",
  "electronics",
  "tools",
  "furniture",
  "outdoor_equipment",
  "musical_instrument",
  "sporting_goods",
  "appliance",
  "collectible",
];

const SERVICE_TOKEN = String(process.env.MARKET_VALUE_TOKEN || "").trim();

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;

// Every Mike AI user reaches this route from one Railway egress IP, so a purely
// IP-keyed bucket throttles the whole app the moment two people price items at
// the same time — a shop working through a counter of goods hits it alone.
// A caller presenting the shared service token is a known first-party service
// rather than an anonymous visitor, so it gets its own larger bucket. With no
// token configured nothing is trusted and the anonymous limit is unchanged.
const TRUSTED_MAX_REQUESTS = (() => {
  const configured = Number(process.env.MARKET_VALUE_TRUSTED_RATE_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60;
})();

function rateLimit(req: Request, res: Response, trusted: boolean): boolean {
  const key = trusted ? "trusted:service-token" : `ip:${req.ip || "unknown"}`;
  const limit = trusted ? TRUSTED_MAX_REQUESTS : MAX_REQUESTS;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    res.status(429).json({ error: "Too many market-value requests — try again shortly" });
    return false;
  }
  return true;
}

function parseHiddenCosts(value: unknown): CostItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((raw): CostItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const label = String(item.label || "Known cost").trim().slice(0, 120) || "Known cost";
    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount < 0) return [];
    const certaintyRaw = item.certainty == null ? undefined : Number(item.certainty);
    const certainty = certaintyRaw == null || !Number.isFinite(certaintyRaw)
      ? undefined
      : Math.max(0, Math.min(1, certaintyRaw));
    return [{
      label,
      amount,
      ...(certainty !== undefined ? { certainty } : {}),
      ...(typeof item.required === "boolean" ? { required: item.required } : {}),
    }];
  });
}

// Supported merchandise should not silently terminate at zero comparables just
// because the first eBay category or exact-title query is too narrow. Keep the
// existing search untouched as attempt one, then broaden only after it returns
// nothing. The pricing engine still receives the same Comparable shape and all
// existing relevance/outlier/condition logic inside fetchComparables remains in
// force. Firearms and jewelry never reach this route because they are excluded
// before DealTough is called.
const SEARCH_NOISE = new Set([
  "black", "white", "gray", "grey", "silver", "red", "blue", "green", "brown",
  "new", "used", "vintage", "classic", "premium", "professional", "heavy", "duty",
]);

function comparableSearchTitles(title: string): string[] {
  const original = String(title || "").trim().replace(/\s+/g, " ");
  if (!original) return [];
  const words = original.split(" ");
  const cleanedWords = words.filter((word) => !SEARCH_NOISE.has(word.toLowerCase().replace(/[^a-z0-9-]/g, "")));
  const cleaned = cleanedWords.join(" ").trim();

  // Preserve the front of the title (normally brand/model) and the end (normally
  // the actual item type) when producing broader fallbacks.
  const family = words.length > 5
    ? [...words.slice(0, 3), ...words.slice(-2)].join(" ")
    : original;
  const brandAndType = words.length > 3
    ? [words[0], ...words.slice(-2)].join(" ")
    : original;

  return [...new Set([original, cleaned, family, brandAndType].filter((value) => value && value.length >= 3))];
}

async function fetchComparablesWithRecovery(params: {
  title: string;
  category: DealCategory;
  askingPrice?: number;
  limit?: number;
}): Promise<{ comparables: Comparable[]; searchTitle: string; searchScope: "category" | "all"; attempts: number }> {
  const titles = comparableSearchTitles(params.title);
  let attempts = 0;

  // Attempt one is intentionally identical to the historical behavior.
  for (const searchTitle of titles) {
    attempts += 1;
    const scoped = await fetchComparables({
      title: searchTitle,
      category: params.category,
      askingPrice: params.askingPrice,
      limit: params.limit,
    });
    if (scoped.length) return { comparables: scoped, searchTitle, searchScope: "category", attempts };

    // A valid item can live outside our coarse category map (safes are a good
    // example). Only after the category-scoped search yields nothing do we let
    // eBay search all departments; fetchComparables still applies its relevance,
    // accessory, model-match and outlier protections.
    attempts += 1;
    const unscoped = await fetchComparables({
      title: searchTitle,
      askingPrice: params.askingPrice,
      limit: params.limit,
    });
    if (unscoped.length) return { comparables: unscoped, searchTitle, searchScope: "all", attempts };
  }

  return { comparables: [], searchTitle: titles.at(-1) || params.title, searchScope: "all", attempts };
}

export function installMarketValueRoute(app: Application): void {
  app.post("/api/v1/market-value", async (req, res) => {
    const trusted = Boolean(SERVICE_TOKEN) && req.get("x-dealtough-token") === SERVICE_TOKEN;
    if (SERVICE_TOKEN && !trusted) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!rateLimit(req, res, trusted)) return;
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
    const location = req.body?.location ? String(req.body.location).trim().slice(0, 240) : undefined;
    const daysListedRaw = req.body?.daysListed;
    const daysListed = daysListedRaw == null || daysListedRaw === "" ? undefined : Number(daysListedRaw);
    const hiddenCosts = parseHiddenCosts(req.body?.hiddenCosts);

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
    if (daysListed !== undefined && (!Number.isFinite(daysListed) || daysListed < 0)) {
      res.status(400).json({ error: "daysListed must be a non-negative number when supplied." });
      return;
    }

    try {
      const comparableResult = await fetchComparablesWithRecovery({
        title,
        category: category as DealCategory,
        askingPrice: askingPrice ?? undefined,
        limit: 50,
      });
      const comparables = comparableResult.comparables;
      if (comparableResult.attempts > 1) {
        console.info("[market-value] comparable recovery", JSON.stringify({
          title,
          category,
          attempts: comparableResult.attempts,
          searchTitle: comparableResult.searchTitle,
          searchScope: comparableResult.searchScope,
          comparables: comparables.length,
        }));
      }

      const engineAskingPrice = askingPrice ?? 1;
      const input: DealInput = {
        category: category as DealCategory,
        title,
        askingPrice: engineAskingPrice,
        condition: ["new", "like_new", "good", "fair", "poor", "unknown"].includes(condition)
          ? condition as DealInput["condition"]
          : "unknown",
        description,
        location,
        ...(daysListed !== undefined ? { daysListed } : {}),
        ...(hiddenCosts.length ? { hiddenCosts } : {}),
        comparables,
        riskSignals: [],
        requiredFieldsPresent: 0,
        photoQuality: 0,
      };

      const recommendation = analyzeDeal(input);
      const resaleAvailable = recommendation.valuationBasis === "comparables" && recommendation.fairMarketValue > 0;
      const buyTargetPrice = resaleAvailable ? recommendation.greatDealPrice : null;
      const maxBuyPrice = resaleAvailable ? recommendation.goodDealPrice : null;
      const knownCostTotal = hiddenCosts.reduce((sum, item) => sum + item.amount, 0);
      const grossSpreadAtTarget = resaleAvailable && buyTargetPrice !== null
        ? Math.max(0, recommendation.fairMarketValue - buyTargetPrice)
        : null;
      const grossRoiAtTargetPercent = grossSpreadAtTarget !== null && buyTargetPrice && buyTargetPrice > 0
        ? Math.round((grossSpreadAtTarget / buyTargetPrice) * 100)
        : null;
      const netSpreadAtTargetAfterKnownCosts = resaleAvailable && buyTargetPrice !== null
        ? recommendation.fairMarketValue - buyTargetPrice - knownCostTotal
        : null;
      const targetCashInvested = buyTargetPrice !== null ? buyTargetPrice + knownCostTotal : null;
      const netRoiAtTargetAfterKnownCostsPercent = netSpreadAtTargetAfterKnownCosts !== null && targetCashInvested && targetCashInvested > 0
        ? Math.round((netSpreadAtTargetAfterKnownCosts / targetCashInvested) * 100)
        : null;

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
        comparableSearch: {
          attempts: comparableResult.attempts,
          searchTitle: comparableResult.searchTitle,
          searchScope: comparableResult.searchScope,
        },
        assumptions: recommendation.assumptions,
        engineVersion: recommendation.engineVersion,
        knownCosts: hiddenCosts,
        knownCostTotal,
        decision: askingPrice !== null && recommendation.valuationBasis === "comparables"
          ? {
              dealScore: recommendation.dealScore,
              verdict: recommendation.verdict,
              trueCost: recommendation.trueCost,
              estimatedSavings: recommendation.estimatedSavings,
              openingOffer: recommendation.openingOffer,
              targetPrice: recommendation.targetPrice,
              walkAwayPrice: recommendation.walkAwayPrice,
              goodDealPrice: recommendation.goodDealPrice,
              greatDealPrice: recommendation.greatDealPrice,
              riskLevel: recommendation.riskLevel,
              breakdown: recommendation.breakdown,
              reasons: recommendation.reasons,
              topRisks: recommendation.topRisks,
              sellerQuestions: recommendation.sellerQuestions,
              negotiationMessage: recommendation.negotiationMessage,
            }
          : null,
        resale: resaleAvailable
          ? {
              available: true,
              expectedResalePrice: recommendation.fairMarketValue,
              buyTargetPrice,
              maxBuyPrice,
              grossSpreadAtTarget,
              grossRoiAtTargetPercent,
              knownCostTotal,
              netSpreadAtTargetAfterKnownCosts,
              netRoiAtTargetAfterKnownCostsPercent,
              basis: hiddenCosts.length
                ? "DealTough fair market value from comparable listings. Net spread/ROI subtract the known costs supplied by the caller; any unknown future costs remain excluded."
                : "DealTough fair market value from comparable listings; buy targets use the existing DTE-1.1 price ladder. Gross spread/ROI exclude repair, transport, tax, platform and selling costs unless those are supplied.",
            }
          : {
              available: false,
              expectedResalePrice: null,
              buyTargetPrice: null,
              maxBuyPrice: null,
              grossSpreadAtTarget: null,
              grossRoiAtTargetPercent: null,
              knownCostTotal,
              netSpreadAtTargetAfterKnownCosts: null,
              netRoiAtTargetAfterKnownCostsPercent: null,
              basis: "No defensible comparable-based valuation was established after progressive comparable search.",
            },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market-value lookup failed";
      res.status(502).json({ error: message });
    }
  });
}
