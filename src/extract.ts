import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
import type { DealCategory, Condition, RiskSeverity } from "./types.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.anthropicApiKey() });
  }
  return client;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ExtractPhoto {
  base64: string;
  mediaType: ImageMediaType;
}

export interface ExtractInput {
  rawText: string;
  photos?: ExtractPhoto[];
  categoryOverride?: DealCategory;
}

export interface ExtractedRiskSignal {
  code: string;
  label: string;
  severity: RiskSeverity;
  evidence?: string;
}

export interface ExtractedListing {
  title: string;
  category: DealCategory;
  askingPrice: number;
  condition?: Condition;
  description?: string;
  sellerRating?: number;
  sellerReviewCount?: number;
  riskSignals: ExtractedRiskSignal[];
  requiredFieldsPresent: number;
  photoQuality: number;
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    category: {
      type: "string",
      enum: ["vehicle", "electronics", "tools", "furniture", "outdoor_equipment"],
    },
    askingPrice: { type: "number" },
    condition: {
      type: "string",
      enum: ["new", "like_new", "good", "fair", "poor", "unknown"],
    },
    description: { type: "string" },
    sellerRating: { type: "number" },
    sellerReviewCount: { type: "number" },
    riskSignals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          label: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          evidence: { type: "string" },
        },
        required: ["code", "label", "severity"],
        additionalProperties: false,
      },
    },
    requiredFieldsPresent: { type: "number" },
    photoQuality: { type: "number" },
  },
  required: ["title", "category", "askingPrice", "riskSignals", "requiredFieldsPresent", "photoQuality"],
  additionalProperties: false,
} as const;

function buildPrompt(rawText: string, categoryOverride?: DealCategory): string {
  const categoryLine = categoryOverride
    ? `The category is known to be "${categoryOverride}" — use it as-is.`
    : "Infer the category from the listing.";

  return `You are extracting structured data from a secondhand marketplace listing for a
deal-evaluation tool. Read the pasted listing text below (and any attached photos) and
return the fields defined by the JSON schema.

${categoryLine}

Guidance:
- riskSignals: flag anything a cautious buyer should know — scammy phrasing ("wire only",
  "ship before you see it"), "as-is"/"no returns"/"salvage title", vague or evasive
  descriptions, prices far below market, or in photos: visible damage, mismatched item vs
  description, stock-photo reuse, watermarks, inconsistent lighting suggesting a scraped
  image. Use severity "critical" only for things that should make a buyer walk away
  outright (e.g. clear scam indicators, activation locks, salvage/rebuilt titles).
- requiredFieldsPresent (0..1): how complete the listing itself is (price, condition,
  description, specifics) — not about photos.
- photoQuality (0..1): 0 if no photos were provided; otherwise how informative/clear they
  are for assessing condition.
- If askingPrice isn't stated, make your best numeric estimate from context rather than
  omitting it.

Listing text:
"""
${rawText}
"""`;
}

export async function extractListingFields(input: ExtractInput): Promise<ExtractedListing> {
  const content: Anthropic.ContentBlockParam[] = [
    ...(input.photos ?? []).map(
      (photo): Anthropic.ImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: photo.mediaType, data: photo.base64 },
      }),
    ),
    {
      type: "text",
      text: buildPrompt(input.rawText, input.categoryOverride),
    },
  ];

  const response = await getClient().messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    throw new Error("Anthropic extraction response had no text block");
  }

  return JSON.parse(textBlock.text) as ExtractedListing;
}
