import { CATEGORY_CONFIG } from "./config.js";
import { clamp, roundMoney, severityPenalty, weightedMedian } from "./math.js";
import type {
  Comparable,
  Condition,
  DealInput,
  DealRecommendation,
  RiskSeverity,
  ScoreBreakdown,
} from "./types.js";

function validateInput(input: DealInput): void {
  if (!input.title?.trim()) throw new Error("title is required");
  if (!Number.isFinite(input.askingPrice) || input.askingPrice <= 0) {
    throw new Error("askingPrice must be greater than zero");
  }
  if (!Array.isArray(input.comparables)) {
    throw new Error("comparables must be an array");
  }
}

// Ordinal scale for condition, so "how far apart are these two items" is a
// number. Unknown has no rank — it means no information, not middling.
const CONDITION_RANK: Record<string, number> = {
  new: 5, like_new: 4, good: 3, fair: 2, poor: 1,
};

function conditionRank(condition?: Condition): number | null {
  if (!condition || condition === "unknown") return null;
  return CONDITION_RANK[condition] ?? null;
}

// A mint comparable says little about a beaten-up listing and vice versa.
// Neutral when either side is unlabeled — an unknown condition is missing
// data, and guessing at it would be worse than not weighting on it.
function conditionAffinity(comp: Comparable, listingCondition?: Condition): number {
  const compRank = conditionRank(comp.condition);
  const listingRank = conditionRank(listingCondition);
  if (compRank == null || listingRank == null) return 1;
  return clamp(1 - Math.abs(compRank - listingRank) * 0.18, 0.4, 1);
}

function comparableWeight(comp: Comparable, listingCondition?: Condition): number {
  const similarity = clamp(comp.similarity ?? 0.65, 0.1, 1);
  const soldBoost = comp.sold ? 1.2 : 1;
  const distancePenalty = comp.distanceMiles == null
    ? 1
    : clamp(1 - comp.distanceMiles / 1000, 0.6, 1);
  return similarity * soldBoost * distancePenalty * conditionAffinity(comp, listingCondition);
}

// How much of the blanket category condition discount is still warranted.
//
// That discount exists because the comparable set is assumed to be in
// generic (roughly average) condition while the listing may not be. Once
// comparables carry their own condition labels that assumption is testable,
// and applying the discount anyway would charge the listing twice for the
// same wear. Returns 1 when nothing is labeled — the original behaviour.
function residualConditionGap(
  comparables: Comparable[],
  listingCondition: Condition | undefined,
  weightOf: (comp: Comparable) => number,
): number {
  const listingRank = conditionRank(listingCondition);
  if (listingRank == null) return 1;

  let labeledWeight = 0;
  let totalWeight = 0;
  let rankWeightSum = 0;
  for (const comp of comparables) {
    const weight = weightOf(comp);
    totalWeight += weight;
    const rank = conditionRank(comp.condition);
    if (rank != null) {
      labeledWeight += weight;
      rankWeightSum += rank * weight;
    }
  }

  if (!totalWeight || !labeledWeight) return 1;

  const coverage = labeledWeight / totalWeight;
  const meanComparableRank = rankWeightSum / labeledWeight;
  // Two ranks of separation is about where the category discounts are
  // calibrated, so that is treated as the full effect.
  const gap = clamp((meanComparableRank - listingRank) / 2, 0, 1);
  return coverage * gap + (1 - coverage);
}

// An active listing is what a seller hopes for; a completed sale is what a
// buyer paid. On secondhand goods the second is reliably lower — sellers
// accept offers below list, and the listings that never sell are precisely
// the overpriced ones, so they linger in search results and skew the median
// upward.
//
// The sold-vs-active weighting in comparableWeight is relative, so when every
// comparable is an active listing it cancels out entirely and fair market
// value ends up anchored to asking prices with nothing correcting it. This is
// the absolute correction for that case.
//
// 12% is a calibration estimate, not a measurement: measuring it would need
// the sold data this exists to substitute for. It is deliberately on the
// conservative side and errs downward, because the two directions are not
// equally costly — understating value makes a good deal look ordinary, while
// overstating it tells someone to buy something they should have walked away
// from. Revisit if the Marketplace Insights scope is ever granted.
const ASKING_PRICE_PREMIUM = 0.12;

// When every comparable is priced far below the asking price, exactly one of
// two things is true and nothing here can tell which: the listing is wildly
// overpriced, or the search returned parts instead of the item. A live search
// for a Weber Genesis II grill produced 50 results and not one was a grill,
// medianing $46 against a $400 asking price.
//
// The comparables are kept either way — discarding them would rate a genuinely
// overpriced listing as fair, which is the more dangerous mistake. But both
// explanations mean the number is weak, so the report says so and confidence
// stops claiming support the comparables do not provide. Mirrors the price
// floor in ebay.ts; that filter and this warning describe the same cliff.
const SUSPECT_COMPARABLE_RATIO = 0.35;

function estimateMarketValue(input: DealInput): {
  fairMarketValue: number;
  comparableCount: number;
  activeShare: number;
  suspectComparables: boolean;
  assumptions: string[];
} {
  const config = CATEGORY_CONFIG[input.category];
  const valid = input.comparables.filter(
    (c) => Number.isFinite(c.price) && c.price > 0
  );

  const assumptions: string[] = [];
  if (!valid.length) {
    assumptions.push("No usable comparable prices were supplied; market value is provisional.");
    return {
      fairMarketValue: input.askingPrice,
      comparableCount: 0,
      activeShare: 1,
      suspectComparables: false,
      assumptions,
    };
  }

  const condition = input.condition ?? "unknown";
  const weightOf = (c: Comparable): number => comparableWeight(c, input.condition);

  const base = weightedMedian(
    valid.map((c) => ({ value: c.price, weight: weightOf(c) }))
  );

  const conditionDiscount = config.conditionDiscounts[condition] ?? config.conditionDiscounts.unknown;
  const residual = residualConditionGap(valid, input.condition, weightOf);

  // Weighted rather than counted, so a single loosely-matching sold item does
  // not buy off the whole adjustment.
  let soldWeight = 0;
  let totalWeight = 0;
  for (const comp of valid) {
    const weight = weightOf(comp);
    totalWeight += weight;
    if (comp.sold) soldWeight += weight;
  }
  const activeShare = totalWeight ? 1 - soldWeight / totalWeight : 1;
  const askingBias = ASKING_PRICE_PREMIUM * activeShare;

  const adjusted = base * (1 - conditionDiscount * residual) * (1 - askingBias);

  if (askingBias > 0.005) {
    assumptions.push(
      activeShare > 0.995
        ? `No completed sales were available, so market value was taken from active listings and reduced ${(askingBias * 100).toFixed(0)}% to allow for the gap between asking and selling prices.`
        : `Comparables were mostly active listings rather than completed sales, so market value was reduced ${(askingBias * 100).toFixed(0)}% to allow for the gap between asking and selling prices.`,
    );
  }

  const suspectComparables =
    input.askingPrice > 0 &&
    valid.every((c) => c.price < input.askingPrice * SUSPECT_COMPARABLE_RATIO);

  if (suspectComparables) {
    assumptions.push(
      `Every comparable was priced under ${(SUSPECT_COMPARABLE_RATIO * 100).toFixed(0)}% of the asking price. Either this listing is far above market, or the comparables are parts and accessories rather than the item itself — worth checking before trusting the market value.`,
    );
  }

  if (condition === "unknown") {
    assumptions.push("Condition was unknown, so a protective category discount was applied.");
  } else if (residual < 0.95) {
    assumptions.push(
      "Comparables carried their own condition labels, so the category condition discount was reduced to avoid counting the same wear twice.",
    );
  }

  return {
    fairMarketValue: roundMoney(Math.max(1, adjusted)),
    comparableCount: valid.length,
    activeShare,
    suspectComparables,
    assumptions,
  };
}

function estimateTrueCost(input: DealInput): {
  trueCost: number;
  hiddenCostTotal: number;
  assumptions: string[];
} {
  const config = CATEGORY_CONFIG[input.category];
  const supplied = input.hiddenCosts ?? [];
  const suppliedTotal = supplied.reduce(
    (sum, item) => sum + Math.max(0, item.amount),
    0
  );
  const assumptions: string[] = [];

  let hiddenCostTotal = suppliedTotal;
  if (!supplied.length) {
    hiddenCostTotal = input.askingPrice * config.defaultHiddenCostRate;
    assumptions.push(
      `No hidden costs were supplied; a protective ${(config.defaultHiddenCostRate * 100).toFixed(0)}% category reserve was used.`
    );
  }

  return {
    trueCost: roundMoney(input.askingPrice + hiddenCostTotal),
    hiddenCostTotal: roundMoney(hiddenCostTotal),
    assumptions,
  };
}

function scoreValue(trueCost: number, fairMarketValue: number): number {
  if (fairMarketValue <= 0) return 0;
  const ratio = trueCost / fairMarketValue;
  // Full score at <=75% of FMV; 20 points at FMV; zero around 140%+.
  if (ratio <= 0.75) return 35;
  if (ratio <= 1) return 35 - ((ratio - 0.75) / 0.25) * 15;
  return clamp(20 - ((ratio - 1) / 0.40) * 20, 0, 20);
}

function scoreRisk(input: DealInput): {
  score: number;
  riskLevel: DealRecommendation["riskLevel"];
  topRisks: string[];
} {
  const signals = input.riskSignals ?? [];
  let penalty = signals.reduce(
    (sum, signal) => sum + severityPenalty[signal.severity],
    0
  );

  if ((input.requiredFieldsPresent ?? 0.7) < 0.55) penalty += 4;
  if ((input.photoQuality ?? 0.65) < 0.4) penalty += 3;
  if (
    input.sellerRating != null &&
    input.sellerReviewCount != null &&
    input.sellerReviewCount >= 3 &&
    input.sellerRating < 3.5
  ) penalty += 4;

  const hasCritical = signals.some((s) => s.severity === "critical");
  const hasHigh = signals.some((s) => s.severity === "high");

  const score = clamp(20 - penalty, 0, 20);
  const riskLevel: DealRecommendation["riskLevel"] =
    hasCritical || score <= 4
      ? "Critical"
      : hasHigh || score <= 10
      ? "High"
      : score <= 15
      ? "Moderate"
      : "Low";

  return {
    score,
    riskLevel,
    topRisks: signals
      .sort((a, b) => {
        const rank: Record<RiskSeverity, number> = {
          critical: 4, high: 3, medium: 2, low: 1
        };
        return rank[b.severity] - rank[a.severity];
      })
      .slice(0, 5)
      .map((s) => s.evidence ? `${s.label}: ${s.evidence}` : s.label),
  };
}

function scoreTrueCost(hiddenCostTotal: number, askingPrice: number): number {
  const ratio = hiddenCostTotal / askingPrice;
  if (ratio <= 0.02) return 15;
  if (ratio <= 0.10) return 15 - ((ratio - 0.02) / 0.08) * 5;
  if (ratio <= 0.30) return 10 - ((ratio - 0.10) / 0.20) * 8;
  return clamp(2 - ((ratio - 0.30) / 0.40) * 2, 0, 2);
}

function scoreNegotiation(input: DealInput): number {
  const days = clamp(input.daysListed ?? 0, 0, 90);
  const reductions = clamp(input.priceReductionCount ?? 0, 0, 4);
  const supply = clamp(input.inventoryIndex ?? 0.5, 0, 1);
  const demand = clamp(input.demandIndex ?? 0.5, 0, 1);

  const dayPoints = (days / 90) * 4;
  const reductionPoints = (reductions / 4) * 2.5;
  const supplyPoints = supply * 2;
  const lowDemandPoints = (1 - demand) * 1.5;
  return clamp(dayPoints + reductionPoints + supplyPoints + lowDemandPoints, 0, 10);
}

function scoreMarket(input: DealInput): number {
  const demand = clamp(input.demandIndex ?? 0.5, 0, 1);
  const inventory = clamp(input.inventoryIndex ?? 0.5, 0, 1);
  // Healthy demand supports resale; extreme scarcity reduces negotiating room.
  const demandQuality = 1 - Math.abs(demand - 0.65) / 0.65;
  const inventoryQuality = 1 - Math.abs(inventory - 0.55) / 0.55;
  return clamp((demandQuality * 6) + (inventoryQuality * 4), 0, 10);
}

// An asking price is one seller's opinion; a sold price is what two people
// actually agreed on. Comparables built from active listings are therefore
// weaker evidence, and confidence should say so — the asking-price haircut
// corrects the estimate, but it cannot make the estimate any better known.
// Worth at most a full point of the ten, so an otherwise complete listing
// still reports respectable confidence.
const ACTIVE_COMPARABLE_PENALTY = 0.25;

function calculateConfidence(
  input: DealInput,
  comparableCount: number,
  activeShare: number,
  suspectComparables: boolean,
): number {
  const evidenceQuality =
    (1 - ACTIVE_COMPARABLE_PENALTY * clamp(activeShare, 0, 1)) *
    (suspectComparables ? 0.5 : 1);
  const compScore = clamp(comparableCount / 8, 0, 1) * 4 * evidenceQuality;
  const completeness = clamp(input.requiredFieldsPresent ?? 0.65, 0, 1) * 2.5;
  const photos = clamp(input.photoQuality ?? 0.6, 0, 1) * 1.5;
  const conditionKnown = input.condition && input.condition !== "unknown" ? 1 : 0.35;
  const sellerEvidence =
    input.sellerRating != null && input.sellerReviewCount != null ? 1 : 0.35;

  return clamp(compScore + completeness + photos + conditionKnown + sellerEvidence, 0, 10);
}

function verdictFor(score: number, riskLevel: DealRecommendation["riskLevel"]): DealRecommendation["verdict"] {
  // Protective overrides: a dangerous listing cannot be rescued by a cheap price.
  if (riskLevel === "Critical") return "Walk Away";
  if (riskLevel === "High" && score >= 60) return "High Risk";
  if (score >= 95) return "Exceptional Deal";
  if (score >= 90) return "Excellent Deal";
  if (score >= 80) return "Great Buy";
  if (score >= 70) return "Good Deal";
  if (score >= 60) return "Fair Deal";
  if (score >= 40) return "High Risk";
  return "Walk Away";
}

function sellerQuestionsFor(input: DealInput): string[] {
  const base = [
    "What is the reason for selling?",
    "Are there any known problems, damage, or missing parts not shown in the listing?",
    "What is the lowest price you would realistically accept for a quick, straightforward sale?",
  ];

  const categoryQuestions: Record<DealInput["category"], string[]> = {
    vehicle: [
      "Can you provide the VIN, title status, service records, and accident history?",
      "What maintenance or repairs will be due in the next 12 months?",
    ],
    electronics: [
      "Is it fully functional, unlocked, and free of account or activation locks?",
      "What is the battery health, and are the charger and original accessories included?",
    ],
    tools: [
      "Can I test it under load before purchasing?",
      "Are the battery, charger, guards, cases, and attachments included?",
    ],
    furniture: [
      "Are there stains, odors, smoke exposure, pet damage, pests, or structural repairs?",
      "What are the exact dimensions, and can it be disassembled for transport?",
    ],
    outdoor_equipment: [
      "Can it be started and tested from cold before purchase?",
      "What service, repairs, storage conditions, and replacement parts should I know about?",
    ],
  };
  return [...categoryQuestions[input.category], ...base].slice(0, 5);
}

function negotiationMessageFor(
  input: DealInput,
  openingOffer: number,
  targetPrice: number
): string {
  return `Hi, I’m interested in the ${input.title}. Based on its condition, the available market comparisons, and the costs I may need to cover after purchase, I could offer $${openingOffer.toLocaleString()} and complete the deal promptly if everything checks out as described. If that is too low, would you consider something near $${targetPrice.toLocaleString()}?`;
}

export function analyzeDeal(input: DealInput): DealRecommendation {
  validateInput(input);

  const market = estimateMarketValue(input);
  const costs = estimateTrueCost(input);
  const risk = scoreRisk(input);

  const valueScore = scoreValue(costs.trueCost, market.fairMarketValue);
  const trueCostScore = scoreTrueCost(costs.hiddenCostTotal, input.askingPrice);
  const negotiationScore = scoreNegotiation(input);
  const marketScore = scoreMarket(input);
  const confidenceScore = calculateConfidence(
    input,
    market.comparableCount,
    market.activeShare,
    market.suspectComparables,
  );

  const breakdown: ScoreBreakdown = {
    value: Math.round(valueScore),
    risk: Math.round(risk.score),
    trueCost: Math.round(trueCostScore),
    negotiation: Math.round(negotiationScore),
    market: Math.round(marketScore),
    confidence: Math.round(confidenceScore),
  };

  let dealScore = Object.values(breakdown).reduce((sum, value) => sum + value, 0);

  // Hard protection rules.
  if (risk.riskLevel === "Critical") dealScore = Math.min(dealScore, 39);
  if (risk.riskLevel === "High") dealScore = Math.min(dealScore, 59);

  const config = CATEGORY_CONFIG[input.category];
  const leverage = negotiationScore / 10;
  const floor = market.fairMarketValue * config.negotiationFloorPercent;
  const openingOffer = roundMoney(
    clamp(
      input.askingPrice * (0.83 - leverage * 0.08),
      floor,
      input.askingPrice
    )
  );
  const targetPrice = roundMoney(
    Math.min(
      input.askingPrice,
      market.fairMarketValue * (0.88 + (1 - leverage) * 0.05)
    )
  );

  // Walk-away is based on true ownership value, not just sticker price.
  const walkAwayPrice = roundMoney(
    Math.max(
      0,
      market.fairMarketValue * 0.98 - costs.hiddenCostTotal
    )
  );

  const estimatedSavings = roundMoney(market.fairMarketValue - costs.trueCost);
  const confidencePercent = Math.round(confidenceScore * 10);

  const reasons: string[] = [];
  const priceRatio = costs.trueCost / market.fairMarketValue;
  if (priceRatio <= 0.85) reasons.push("True estimated cost is materially below fair market value.");
  else if (priceRatio <= 1) reasons.push("True estimated cost is at or below fair market value.");
  else reasons.push("True estimated cost is above fair market value.");

  if (risk.riskLevel === "Low") reasons.push("No major risk signals were identified.");
  if (risk.riskLevel === "Moderate") reasons.push("Some issues should be verified before purchase.");
  if (risk.riskLevel === "High" || risk.riskLevel === "Critical") {
    reasons.push("Risk protection rules limited the final score.");
  }

  if (negotiationScore >= 7) reasons.push("The listing shows strong negotiation leverage.");
  else if (negotiationScore <= 3) reasons.push("Current negotiation leverage appears limited.");

  if (confidencePercent < 60) reasons.push("The recommendation is provisional because important data is missing.");

  return {
    dealScore,
    verdict: verdictFor(dealScore, risk.riskLevel),
    fairMarketValue: market.fairMarketValue,
    goodDealPrice: roundMoney(market.fairMarketValue * 0.90),
    greatDealPrice: roundMoney(market.fairMarketValue * 0.80),
    trueCost: costs.trueCost,
    estimatedSavings,
    openingOffer,
    targetPrice,
    walkAwayPrice,
    confidencePercent,
    riskLevel: risk.riskLevel,
    breakdown,
    reasons,
    topRisks: risk.topRisks.length ? risk.topRisks : ["No explicit risk signals supplied."],
    sellerQuestions: sellerQuestionsFor(input),
    negotiationMessage: negotiationMessageFor(input, openingOffer, targetPrice),
    assumptions: [...market.assumptions, ...costs.assumptions],
    engineVersion: "DTE-1.0",
  };
}
