import type {
  DealInput,
  DealRecommendation,
  Comparable,
  CostItem
} from "./types.js";

export function analyzeDeal(input: DealInput): DealRecommendation {
  const price = input.askingPrice || 0;

  // 1. Calculate market average from comparables
  let marketAvg = price;
  if (input.comparables && input.comparables.length > 0) {
    const total = input.comparables.reduce((acc, comp) => acc + (comp.price || 0), 0);
    marketAvg = total / input.comparables.length;
  }

  const fairMarketMin = Math.round(marketAvg * 0.9);
  const fairMarketMax = Math.round(marketAvg * 1.1);

  // 2. Calculate true cost (Price + Hidden Costs)
  const hiddenCostTotal = (input.hiddenCosts || []).reduce((sum, item) => {
    return sum + (item.estimatedCost ?? 25);
  }, 0);
  const trueCost = price + hiddenCostTotal;

  // 3. Score calculation & Factors
  let score = 75;
  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];

  const hasCriticalRisk = Boolean(input.riskSignals && input.riskSignals.length > 0);

  if (hasCriticalRisk) {
    score = 35;
    negativeFactors.push("Critical risk signal detected");
  } else if (marketAvg > 0 && price < marketAvg) {
    const savingsPercent = Math.round(((marketAvg - price) / marketAvg) * 100);
    const boost = Math.min(savingsPercent, 20);
    score += boost;
    positiveFactors.push(`Listed ${savingsPercent}% below market average`);
  }

  const dealScore = Math.max(0, Math.min(100, score));
  const walkAwayPrice = Math.round(marketAvg * 0.95);

  return {
    dealScore,
    fairMarketRange: {
      min: fairMarketMin,
      max: fairMarketMax,
    },
    trueCost,
    walkAwayPrice,
    scoreBreakdown: {
      positiveFactors,
      negativeFactors,
    },
  } as unknown as DealRecommendation;
}

export { analyzeDeal as evaluateDeal };