import express from "express";
import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDeal } from "./engine.js";
import type { Comparable, DealCategory, DealInput } from "./types.js";
import { isAnthropicConfigured, isDbConfigured, isEbayConfigured } from "./env.js";
import { extractListingFields, type ExtractPhoto } from "./extract.js";
import { fetchComparables } from "./ebay.js";
import { getPrisma } from "./db.js";

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

// ── auth ────────────────────────────────────────────────────────────────
// Single shared API key from DEALTOUGH_API_KEY. When unset the protected
// routes stay open (same degrade-without-crashing posture as the other
// credentials); set it in production.
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.DEALTOUGH_API_KEY;
  if (!configured) {
    next();
    return;
  }
  const provided = Buffer.from(req.get("x-api-key") ?? "");
  const expected = Buffer.from(configured);
  if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
    next();
    return;
  }
  res.status(401).json({ error: "Missing or invalid API key" });
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
app.use(express.json({ limit: "25mb" }));

// Web UI (public/index.html) at /; JSON health check moved to /health.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(currentDir, "../../public")));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, engineVersion: "DTE-1.0" });
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

app.post("/api/v1/deals/from-listing", requireApiKey, rateLimit(6, 60_000), async (req, res) => {
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

  const warnings: string[] = [];

  let extracted;
  try {
    extracted = await extractListingFields({ rawText, photos, categoryOverride });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction failed";
    res.status(502).json({ error: message });
    return;
  }

  const category = categoryOverride ?? extracted.category;
  if (!isValidCategory(category)) {
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
app.get("/api/v1/deals/:id", requireApiKey, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Persistence is not configured" });
    return;
  }
  try {
    const deal = await getPrisma().deal.findUnique({ where: { id: req.params.id } });
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

app.get("/api/v1/deals", requireApiKey, async (req, res) => {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "Persistence is not configured" });
    return;
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const deals = await getPrisma().deal.findMany({
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
