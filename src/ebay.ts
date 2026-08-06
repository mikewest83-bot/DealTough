import { env, isEbayInsightsEnabled } from "./env.js";
import { log } from "./log.js";
import type { Comparable, Condition, DealCategory } from "./types.js";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const INSIGHTS_URL =
  "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search";

const BASE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const INSIGHTS_SCOPE = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Keyed by scope: the Marketplace Insights token is a separate grant, and
// asking for a scope the account is not approved for fails the whole request.
const tokenCache = new Map<string, CachedToken>();

async function getAppToken(scope: string = BASE_SCOPE): Promise<string> {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const id = env.ebayClientId();
  const secret = env.ebayClientSecret();
  const basicAuth = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });

  if (!res.ok) {
    throw new Error(`eBay OAuth token request failed: ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(scope, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

export interface EbaySearchParams {
  title: string;
  category?: DealCategory;
  askingPrice?: number;
  limit?: number;
}

// A bare keyword search hits all of eBay, and for anything with an aftermarket
// that means parts. Searching "2019 Ford F-150 XLT SuperCrew" unconstrained
// returns seat covers, grilles and window glass; the two actual trucks in the
// results were then discarded as outliers, because the parts set the median.
// Constraining to eBay Motors > Cars & Trucks returns trucks and nothing else.
//
// Ids were checked against live searches rather than taken from the taxonomy
// suggester, which files a pickup under Collectibles > Advertising. Browse
// rejects more than one id per request (error 12030), so this is one each.
//
// Electronics is deliberately absent. Headphones live under Consumer
// Electronics (293) and laptops under Computers/Tablets (58058); with only one
// id allowed, either choice erases the other product type. Unconstrained
// electronics already tracks the constrained result closely — a WH-1000XM5
// medians $141 either way — so there is nothing to buy here and real coverage
// to lose.
const CATEGORY_IDS: Partial<Record<DealCategory, string>> = {
  vehicle: "6001", // Cars & Trucks
  tools: "631", // Home & Garden > Tools & Workshop Equipment
  furniture: "3197", // Home & Garden > Furniture
  outdoor_equipment: "159912", // Home & Garden > Yard, Garden & Outdoor Living
};

// Parts are cheap relative to the thing they bolt onto, and they survive both
// the category filter and the accessory word list — a $65 caster sits in the
// same eBay category as the $600 chair it belongs to. Anything under this
// fraction of the asking price is treated as not-the-item.
//
// Chosen by sweeping ratios over live results in all five categories. The
// deciding case was an Aeron chair: below 0.25 the comparables are armrest
// pads and gas cylinders and the median sits at $150, above it the median
// snaps to $598 and the actual chairs. 0.35 clears that cliff with margin.
//
// Higher would score better on some samples, but the floor is defined against
// the asking price, so raising it increasingly assumes the seller is right --
// discarding cheap-but-real comparables is exactly how an overpriced listing
// gets rated a fair one. At 0.35, a $28,000 truck still keeps $9,800
// comparables, which is the case where a user most needs to be told to walk.
const PRICE_FLOOR_RATIO = 0.35;

// Applied before outlier rejection, so the median is computed over real items
// rather than over the parts. If the floor removes everything, the asking
// price is the more likely error — an unpriced typo or a wrong unit — so the
// comparables are kept and the engine's own confidence scoring handles it.
function rejectPartsPricedBelow(comparables: Comparable[], askingPrice?: number): Comparable[] {
  if (!askingPrice || !Number.isFinite(askingPrice) || askingPrice <= 0) return comparables;

  const floor = askingPrice * PRICE_FLOOR_RATIO;
  const kept = comparables.filter((c) => c.price >= floor);
  return kept.length ? kept : comparables;
}

// ── relevance ───────────────────────────────────────────────────────────
// A keyword search returns whatever shares words with the query, so a hunt
// for "2019 Ford F-150" comes back with die-cast models, floor mats, and
// headlights. Those prices are real, so nothing downstream rejects them —
// they just quietly drag the market value toward $40. Everything below
// exists to keep that from happening.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "our",
  "new", "used", "oem", "genuine", "original", "great", "nice", "excellent",
]);

// Hyphens carry model numbers ("F-150", "RTX-3080"), so they collapse rather
// than split — otherwise "F-150" becomes "f" + "150" and the "f" is dropped
// as noise, losing half the identity of the item.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[-–—/]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

// A model number or year identifies an item far more reliably than its
// adjectives: "2019" and "150" say more than "great" or "truck".
const tokenWeight = (token: string): number => (/\d/.test(token) ? 2 : 1);

// Share of the reference title's weighted tokens that the candidate also has.
// Deliberately asymmetric — a candidate with extra words ("2019 Ford F-150
// XLT Crew Cab") is still a fine comparable, but one missing "F-150" is not.
export function titleSimilarity(reference: string, candidate: string): number {
  const referenceTokens = tokenize(reference);
  if (!referenceTokens.length) return 0.5;

  const candidateTokens = new Set(tokenize(candidate));
  let matched = 0;
  let total = 0;
  for (const token of referenceTokens) {
    const weight = tokenWeight(token);
    total += weight;
    if (candidateTokens.has(token)) matched += weight;
  }
  return total ? matched / total : 0;
}

// Below this, the candidate is a different product that happens to share a
// word or two.
const MIN_SIMILARITY = 0.34;

// Phrases that mark a hit as an accessory, part, or replica rather than the
// thing itself. Only disqualifying when the phrase is absent from the
// reference title — if you are actually shopping for a charger, "charger" is
// the item, not noise.
const ACCESSORY_MARKERS = [
  "for parts", "not working", "parts only", "as-is broken", "broken",
  "repair kit", "replacement part", "case", "cover", "screen protector",
  "manual", "brochure", "poster", "sticker", "decal", "keychain",
  "diecast", "die cast", "model car", "replica", "toy", "miniature",
  "1:18", "1/18", "1:24", "1/24", "bracket", "adapter", "cable",
  "charger", "remote", "filter", "floor mat", "seat cover", "emblem",
  "badge", "t-shirt", "shirt", "hat", "mug", "keyring", "pin",
];

function isAccessory(candidateTitle: string, referenceTitle: string): boolean {
  const candidate = candidateTitle.toLowerCase();
  const reference = referenceTitle.toLowerCase();
  return ACCESSORY_MARKERS.some(
    (marker) => candidate.includes(marker) && !reference.includes(marker),
  );
}

// ── condition ───────────────────────────────────────────────────────────
// eBay reports a free-text condition per item. Without it every comparable
// is implicitly "average condition", so a beat-up listing gets measured
// against a shelf of mint ones. Longest/most specific phrases are checked
// first — "new other" and "for parts" both contain shorter matches.
const CONDITION_PATTERNS: Array<[string, Condition]> = [
  ["for parts or not working", "poor"],
  ["for parts", "poor"],
  ["not working", "poor"],
  ["parts only", "poor"],
  ["salvage", "poor"],
  ["acceptable", "fair"],
  ["new other", "like_new"],
  ["new with defects", "fair"],
  ["new without", "like_new"],
  ["open box", "like_new"],
  ["like new", "like_new"],
  ["excellent", "like_new"],
  ["very good", "good"],
  ["refurbished", "good"],
  ["pre-owned", "good"],
  ["preowned", "good"],
  ["seller refurbished", "good"],
  ["good", "good"],
  ["fair", "fair"],
  ["poor", "poor"],
  ["brand new", "new"],
  ["new", "new"],
  ["used", "good"],
];

export function normalizeCondition(raw: unknown): Condition | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.toLowerCase();
  for (const [pattern, condition] of CONDITION_PATTERNS) {
    if (value.includes(pattern)) return condition;
  }
  return undefined;
}

// Median absolute deviation, applied after relevance filtering so the median
// is already anchored to real matches. 1.4826 rescales MAD to a standard
// deviation for normally distributed data; 3.5 of those is the conventional
// "not from this population" line. Left alone under four items — with three
// prices there is no distribution to reason about.
function rejectPriceOutliers(comparables: Comparable[]): Comparable[] {
  if (comparables.length < 4) return comparables;

  const prices = comparables.map((c) => c.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const deviations = prices.map((p) => Math.abs(p - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];
  if (mad <= 0) return comparables; // prices are tightly clustered already

  const limit = 3.5 * 1.4826 * mad;
  return comparables.filter((c) => Math.abs(c.price - median) <= limit);
}

interface BrowseItem {
  price?: { value?: string };
  title?: string;
  condition?: string;
}

interface ItemSale {
  lastSoldPrice?: { value?: string };
  title?: string;
  condition?: string;
}

// Shared by the active and sold mappers: relevance gate, condition parse,
// and the outlier pass. `referenceTitle` is the listing being evaluated;
// without it there is nothing to judge relevance against, so every priced
// item is kept at a neutral weight.
function buildComparables(
  rows: Array<{ price?: string; title?: string; condition?: string }>,
  referenceTitle: string | undefined,
  source: string,
  sold: boolean,
  askingPrice?: number,
): Comparable[] {
  const comparables: Comparable[] = [];
  for (const row of rows) {
    if (!row.price) continue;
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    let similarity = 0.5;
    if (referenceTitle) {
      const title = row.title ?? "";
      if (isAccessory(title, referenceTitle)) continue;
      similarity = titleSimilarity(referenceTitle, title);
      if (similarity < MIN_SIMILARITY) continue;
    }

    comparables.push({
      price,
      similarity,
      source,
      sold,
      condition: normalizeCondition(row.condition),
    });
  }

  return rejectPriceOutliers(rejectPartsPricedBelow(comparables, askingPrice));
}

// Pure — no network. This is what tests exercise directly against fixture JSON.
export function mapBrowseResultsToComparables(
  data: unknown,
  referenceTitle?: string,
  askingPrice?: number,
): Comparable[] {
  const items = (data as { itemSummaries?: unknown[] })?.itemSummaries;
  if (!Array.isArray(items)) return [];

  return buildComparables(
    items.map((raw) => {
      const item = raw as BrowseItem;
      return { price: item.price?.value, title: item.title, condition: item.condition };
    }),
    referenceTitle,
    "ebay_active",
    false,
    askingPrice,
  );
}

// Marketplace Insights returns what items actually sold for, which is the
// number that matters — asking prices are what sellers hope for, and on used
// goods the gap runs well into double digits.
export function mapItemSalesToComparables(
  data: unknown,
  referenceTitle?: string,
  askingPrice?: number,
): Comparable[] {
  const items = (data as { itemSales?: unknown[] })?.itemSales;
  if (!Array.isArray(items)) return [];

  return buildComparables(
    items.map((raw) => {
      const item = raw as ItemSale;
      return { price: item.lastSoldPrice?.value, title: item.title, condition: item.condition };
    }),
    referenceTitle,
    "ebay_sold",
    true,
    askingPrice,
  );
}

// ── cache ───────────────────────────────────────────────────────────────
// Every analysis otherwise costs an OAuth round trip plus a search, and
// eBay's call quota is a real constraint. Secondhand prices do not move
// hour to hour, so a few hours of staleness is invisible to the user.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// Enough completed sales to stand on their own without active listings.
const SOLD_ONLY_THRESHOLD = 5;

interface CacheEntry {
  comparables: Comparable[];
  expiresAt: number;
}

const comparableCache = new Map<string, CacheEntry>();

// Category and asking price both change which comparables come back — the
// first picks the eBay category searched, the second sets the parts floor —
// so both belong in the key. Leaving them out meant a truck and a toy truck
// sharing a title could share an answer.
function cacheKey(params: EbaySearchParams): string {
  return [
    params.title.trim().toLowerCase(),
    params.category ?? "",
    params.askingPrice ?? "",
    params.limit ?? "",
  ].join("|");
}

function readCache(key: string): Comparable[] | null {
  const entry = comparableCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    comparableCache.delete(key);
    return null;
  }
  // Refresh insertion order so the eviction below is least-recently-used.
  comparableCache.delete(key);
  comparableCache.set(key, entry);
  return entry.comparables;
}

function writeCache(key: string, comparables: Comparable[]): void {
  if (comparableCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = comparableCache.keys().next();
    if (!oldest.done) comparableCache.delete(oldest.value);
  }
  comparableCache.set(key, { comparables, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearComparableCache(): void {
  comparableCache.clear();
  tokenCache.clear();
}

async function fetchSoldComparables(params: EbaySearchParams): Promise<Comparable[]> {
  const token = await getAppToken(INSIGHTS_SCOPE);

  const url = new URL(INSIGHTS_URL);
  url.searchParams.set("q", params.title);
  url.searchParams.set("limit", String(params.limit ?? 50));
  const soldCategory = params.category && CATEGORY_IDS[params.category];
  if (soldCategory) url.searchParams.set("category_ids", soldCategory);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (!res.ok) {
    throw new Error(`eBay Marketplace Insights request failed: ${res.status}`);
  }

  return mapItemSalesToComparables(await res.json(), params.title, params.askingPrice);
}

async function fetchActiveComparables(params: EbaySearchParams): Promise<Comparable[]> {
  const token = await getAppToken();

  const url = new URL(SEARCH_URL);
  // The listing title alone. Appending the category word ("vehicle") pushed
  // the search toward items whose titles literally say "vehicle", which is
  // mostly accessories.
  url.searchParams.set("q", params.title);
  // Over-fetch, because relevance and outlier filtering discard most of it.
  url.searchParams.set("limit", String(params.limit ?? 50));
  const activeCategory = params.category && CATEGORY_IDS[params.category];
  if (activeCategory) url.searchParams.set("category_ids", activeCategory);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (!res.ok) {
    throw new Error(`eBay Browse API request failed: ${res.status}`);
  }

  return mapBrowseResultsToComparables(await res.json(), params.title, params.askingPrice);
}

export async function fetchComparables(params: EbaySearchParams): Promise<Comparable[]> {
  const key = cacheKey(params);
  const cached = readCache(key);
  if (cached) {
    log.debug("ebay.cache_hit", { title: params.title, comparables: cached.length });
    return cached;
  }

  // Sold data needs the Marketplace Insights scope, which eBay grants on
  // request rather than by default — so it is opt-in, and a failure here is
  // never fatal. Active listings still answer the question, just less well.
  let sold: Comparable[] = [];
  if (isEbayInsightsEnabled()) {
    try {
      sold = await fetchSoldComparables(params);
    } catch (error) {
      log.warn("ebay.sold_lookup_failed", {
        title: params.title,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Once there are enough completed sales to form a distribution, asking
  // prices only add noise — a seller can ask anything. Below that threshold
  // both are kept, and the engine's sold-item weighting sorts out the mix.
  const active = sold.length >= SOLD_ONLY_THRESHOLD ? [] : await fetchActiveComparables(params);
  const comparables = [...sold, ...active];

  log.info("ebay.comparables", {
    title: params.title,
    category: params.category,
    categoryId: (params.category && CATEGORY_IDS[params.category]) ?? "unconstrained",
    sold: sold.length,
    active: active.length,
  });

  writeCache(key, comparables);
  return comparables;
}
