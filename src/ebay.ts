import { env } from "./env.js";
import type { Comparable, DealCategory } from "./types.js";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

const CATEGORY_KEYWORDS: Record<DealCategory, string> = {
  vehicle: "vehicle",
  electronics: "electronics",
  tools: "tools",
  furniture: "furniture",
  outdoor_equipment: "outdoor equipment",
};

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

// Pure — no network. This is what tests exercise directly against fixture JSON.
export function mapBrowseResultsToComparables(data: unknown): Comparable[] {
  const items = (data as { itemSummaries?: unknown[] })?.itemSummaries;
  if (!Array.isArray(items)) return [];

  const comparables: Comparable[] = [];
  for (const raw of items) {
    const item = raw as { price?: { value?: string } };
    const value = item.price?.value;
    if (!value) continue;
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 0) continue;

    comparables.push({
      price,
      similarity: 0.5,
      source: "ebay_active",
      sold: false,
    });
  }
  return comparables;
}

export async function fetchComparables(params: EbaySearchParams): Promise<Comparable[]> {
  const token = await getAppToken();
  const query = params.category
    ? `${params.title} ${CATEGORY_KEYWORDS[params.category]}`
    : params.title;

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(params.limit ?? 20));

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
  return mapBrowseResultsToComparables(data);
}
