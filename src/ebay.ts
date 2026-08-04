import { env } from "./env.js";
import type { Comparable, DealCategory } from "./types.js";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
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
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!res.ok) {
    throw new Error(`eBay OAuth token request failed: ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

export interface EbaySearchParams {
  title: string;
  category?: DealCategory;
  limit?: number;
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

// Pure — no network. This is what tests exercise directly against fixture JSON.
// `referenceTitle` is the listing being evaluated; without it there is nothing
// to judge relevance against, so every priced item is kept at a neutral weight.
export function mapBrowseResultsToComparables(
  data: unknown,
  referenceTitle?: string,
): Comparable[] {
  const items = (data as { itemSummaries?: unknown[] })?.itemSummaries;
  if (!Array.isArray(items)) return [];

  const comparables: Comparable[] = [];
  for (const raw of items) {
    const item = raw as BrowseItem;
    const value = item.price?.value;
    if (!value) continue;
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 0) continue;

    let similarity = 0.5;
    if (referenceTitle) {
      const title = item.title ?? "";
      if (isAccessory(title, referenceTitle)) continue;
      similarity = titleSimilarity(referenceTitle, title);
      if (similarity < MIN_SIMILARITY) continue;
    }

    comparables.push({
      price,
      similarity,
      source: "ebay_active",
      sold: false,
    });
  }

  return rejectPriceOutliers(comparables);
}

export async function fetchComparables(params: EbaySearchParams): Promise<Comparable[]> {
  const token = await getAppToken();

  const url = new URL(SEARCH_URL);
  // The listing title alone. Appending the category word ("vehicle") pushed
  // the search toward items whose titles literally say "vehicle", which is
  // mostly accessories.
  url.searchParams.set("q", params.title);
  // Over-fetch, because relevance and outlier filtering discard most of it.
  url.searchParams.set("limit", String(params.limit ?? 50));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (!res.ok) {
    throw new Error(`eBay Browse API request failed: ${res.status}`);
  }

  const data = await res.json();
  return mapBrowseResultsToComparables(data, params.title);
}
