// Sell mode: photos (+ a few notes) in, a ready-to-post listing and a price
// plan out. Plus a reply helper for buyer messages.
//
// The listing text comes from the AI; the prices never do. Prices come from
// the same comparable data and market-value engine the Buy side uses, so a
// seller sees numbers with evidence behind them — or no numbers at all when
// the evidence is missing.

import type Anthropic from "@anthropic-ai/sdk";
import { getClient, type ExtractPhoto } from "./extract.js";
import { estimateMarketValue } from "./engine.js";
import type { Comparable, Condition, DealCategory } from "./types.js";

const MODEL = "claude-opus-5";

export const SELL_CATEGORIES: DealCategory[] = [
  "vehicle", "electronics", "tools", "furniture", "outdoor_equipment",
  "musical_instrument", "sporting_goods", "appliance", "collectible",
];
const CONDITIONS: Condition[] = ["new", "like_new", "good", "fair", "poor", "unknown"];

export interface GeneratedListing {
  category: DealCategory;
  itemName: string;
  searchQuery: string;
  roughValueEstimate: number;
  condition: Condition;
  conditionSummary: string;
  flaws: string[];
  included: string[];
  specs: Array<{ label: string; value: string }>;
  headline: string;
  description: string;
  coverPhotoIndex: number;
  missingShots: string[];
  vin?: string;
  mileage?: number;
}

const LISTING_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: SELL_CATEGORIES },
    itemName: { type: "string" },
    searchQuery: { type: "string" },
    roughValueEstimate: { type: "number" },
    condition: { type: "string", enum: CONDITIONS },
    conditionSummary: { type: "string" },
    flaws: { type: "array", items: { type: "string" } },
    included: { type: "array", items: { type: "string" } },
    specs: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
        additionalProperties: false,
      },
    },
    headline: { type: "string" },
    description: { type: "string" },
    coverPhotoIndex: { type: "number" },
    missingShots: { type: "array", items: { type: "string" } },
    vin: { type: "string" },
    mileage: { type: "number" },
  },
  required: [
    "category", "itemName", "searchQuery", "roughValueEstimate", "condition", "conditionSummary",
    "flaws", "included", "specs", "headline", "description", "coverPhotoIndex", "missingShots",
  ],
  additionalProperties: false,
} as const;

function listingPrompt(notes: string, photoCount: number, categoryHint?: DealCategory): string {
  return `You are helping someone sell a used item on Facebook Marketplace, OfferUp, Craigslist or a dealer lot.
They took ${photoCount} photo(s) (numbered from 0 in the order attached) and wrote the notes below.
Return the fields in the JSON schema.

${categoryHint ? `The seller says the category is "${categoryHint}" — use it.` : "Work out the category."}

Rules:
- Identify the item as precisely as the photos and notes allow (brand, model, size, year, trim).
  Never invent a model number, spec, mileage or accessory you cannot see or that the notes do not state.
- searchQuery: the words a buyer would search to find this exact item for sale (brand + model + key variant), no condition words.
- roughValueEstimate: your rough used-market value in USD. It is only used to filter out parts and accessories
  from a price search and is never shown to anyone.
- condition and conditionSummary: judge from the photos and notes. Be honest; do not upgrade the condition.
- flaws: every visible scratch, dent, wear, stain, crack or missing part you can see, plus any the notes mention.
  An honest listing with flaws disclosed sells faster and avoids disputes.
- headline: under 80 characters, plain words a buyer searches for. No ALL CAPS, no emojis, no "must see", no price.
- description: 80 to 150 words, first person as the seller, friendly and factual: what it is, condition with the flaws
  stated plainly, what is included, why it is worth it. No price (the seller adds it), no phone numbers,
  no "cash only / no lowballers" style lines, no claims you cannot see.
- coverPhotoIndex: the single photo that best shows the whole item.
- missingShots: up to 4 photos that would help sell it and are missing (e.g. "label with model number", "close-up of the dent").
- vin and mileage: only for vehicles, only if clearly readable in a photo or stated in the notes. Otherwise omit.

Seller notes:
"""
${notes || "(no notes)"}
"""`;
}

export async function generateListing(
  photos: ExtractPhoto[],
  notes: string,
  categoryHint?: DealCategory,
): Promise<GeneratedListing> {
  const content: Anthropic.ContentBlockParam[] = [
    ...photos.map((photo): Anthropic.ImageBlockParam => ({
      type: "image",
      source: { type: "base64", media_type: photo.mediaType, data: photo.base64 },
    })),
    { type: "text", text: listingPrompt(notes, photos.length, categoryHint) },
  ];
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: { format: { type: "json_schema", schema: LISTING_SCHEMA } },
    messages: [{ role: "user", content }],
  });
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("The listing writer returned no text");
  const listing = JSON.parse(text.text) as GeneratedListing;
  if (categoryHint) listing.category = categoryHint;
  listing.coverPhotoIndex = Math.min(Math.max(0, Math.round(listing.coverPhotoIndex || 0)), Math.max(0, photos.length - 1));
  listing.headline = listing.headline.slice(0, 100);
  return listing;
}

// ------------------------------------------------------------ price plan

/** Round to numbers people actually list at: $5 steps under $200, $10 under $1,000, $50 under $10k, $100 above. */
export function niceRound(value: number, direction: "up" | "down" | "nearest" = "nearest"): number {
  if (!(value > 0)) return 0;
  const step = value < 200 ? 5 : value < 1000 ? 10 : value < 10000 ? 50 : 100;
  const f = direction === "up" ? Math.ceil : direction === "down" ? Math.floor : Math.round;
  return Math.max(step, f(value / step) * step);
}

export interface PricePlan {
  available: boolean;
  listAt?: number;
  expectAround?: number;
  lowestToAccept?: number;
  fairMarketValue?: number;
  comparableCount: number;
  basis: string;
  notes: string[];
}

// List ~10% above expected value so there is room to negotiate; hold a floor
// ~10% below it. Fixed, explainable rules — not AI guesses.
export const LIST_PREMIUM = 0.10;
export const FLOOR_DISCOUNT = 0.10;

export function buildPricePlan(
  category: DealCategory,
  condition: Condition,
  comparables: Comparable[],
  basis: string,
): PricePlan {
  const market = estimateMarketValue({
    category,
    title: "",
    askingPrice: 0,
    condition,
    comparables,
  });
  if (market.valuationBasis !== "comparables" || !(market.fairMarketValue > 0)) {
    return {
      available: false,
      comparableCount: 0,
      basis,
      notes: ["We couldn't find enough comparable listings to price this confidently. Check similar items near you before setting a price."],
    };
  }
  const fmv = market.fairMarketValue;
  const notes = [...market.assumptions];
  if (market.comparableCount < 4) notes.push("Few comparable listings were found, so treat these prices as a rough guide.");
  return {
    available: true,
    fairMarketValue: fmv,
    listAt: niceRound(fmv * (1 + LIST_PREMIUM), "up"),
    expectAround: niceRound(fmv),
    lowestToAccept: niceRound(fmv * (1 - FLOOR_DISCOUNT), "down"),
    comparableCount: market.comparableCount,
    basis,
    notes,
  };
}

// ------------------------------------------------------------ reply helper

export interface ReplyInput {
  itemName: string;
  listPrice?: number;
  lowestToAccept?: number;
  description?: string;
  buyerMessage: string;
  sellerNote?: string;
}

export interface ReplySuggestion {
  intent: "question" | "availability" | "offer" | "lowball" | "scam_risk" | "logistics" | "other";
  offerAmount?: number;
  reply: string;
  tipForSeller: string;
}

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["question", "availability", "offer", "lowball", "scam_risk", "logistics", "other"] },
    offerAmount: { type: "number" },
    reply: { type: "string" },
    tipForSeller: { type: "string" },
  },
  required: ["intent", "reply", "tipForSeller"],
  additionalProperties: false,
} as const;

function replyPrompt(input: ReplyInput): string {
  return `You help a private seller or small dealer answer a buyer's message about an item for sale.
Write the reply the seller can send as-is, plus a short private tip for the seller.

Item: ${input.itemName}
Listed price: ${input.listPrice ? "$" + input.listPrice : "not given"}
Seller's lowest acceptable price (PRIVATE — never reveal, hint at, or quote this number): ${input.lowestToAccept ? "$" + input.lowestToAccept : "not given"}
Listing description: ${input.description ? input.description.slice(0, 1500) : "not given"}
Seller's extra note: ${input.sellerNote || "none"}

Buyer's message:
"""
${input.buyerMessage.slice(0, 2000)}
"""

Rules for the reply:
- Friendly, short (1 to 4 sentences), sounds like a real person texting. No emojis unless the buyer used them.
- Answer only from the facts above. If the answer isn't known, say you'll check, don't invent.
- Offers: if an offer is at or above the lowest acceptable price, you may accept or counter a little higher.
  If it is below, counter at a price between the offer and the listed price that is not below the lowest
  acceptable price, or politely decline. Never state the lowest acceptable price itself.
- Lowballs (far below the listed price): polite, firm counter or decline.
- Move serious buyers to a concrete next step: a time to see it, and meeting somewhere public in daylight.
- scam_risk: overpayment, "my mover/shipper will pick up", sending a code (e.g. Google Voice verification),
  paying by check/wire/gift card, asking to move off the app, or buying sight-unseen for shipping.
  Then write a safe reply (cash or in-person only, no codes) and warn the seller in tipForSeller.
- offerAmount: the dollar amount the buyer offered, if any.
- tipForSeller: one or two sentences of private advice (e.g. "This is a common scam — don't share any code").`;
}

export async function suggestReply(input: ReplyInput): Promise<ReplySuggestion> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 800,
    output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
    messages: [{ role: "user", content: replyPrompt(input) }],
  });
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("The reply helper returned no text");
  const out = JSON.parse(text.text) as ReplySuggestion;
  // Belt and braces: never let the private floor leak, whatever the model wrote.
  if (input.lowestToAccept && input.lowestToAccept !== input.listPrice) {
    const floor = input.lowestToAccept;
    const pattern = new RegExp(`\\$?\\s?${floor.toLocaleString("en-US").replace(/,/g, ",?")}(?![\\d])`);
    // Quoting the floor back is fine only when the buyer offered that exact number.
    if (pattern.test(out.reply) && !pattern.test(input.buyerMessage)) {
      out.reply = "Thanks for reaching out! It's still available. What price did you have in mind?";
      out.tipForSeller = `The suggested reply mentioned your lowest price, so it was replaced with a safe one. ${out.tipForSeller}`;
    }
  }
  return out;
}

export { replyPrompt as _replyPromptForTests, listingPrompt as _listingPromptForTests };
