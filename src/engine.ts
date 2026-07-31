import type { DealInput, DealRecommendation } from "./types.js";

export function analyzeDeal(input: any): any {
  const price = Number(input?.askingPrice || input?.price || 0);

  // 1. Calculate market average from comparables
  const comparables = Array.isArray(input?.comparables) ? input.comparables : [];
  let marketAvg = price;
  if (comparables.length > 0) {
    const total = comparables.reduce((acc: number, comp: any) => acc + Number(comp?.price || 0), 0);
    marketAvg = total / comparables.length;
  }

  const minMarket = Math.round(marketAvg * 0.9);
  const maxMarket = Math.round(marketAvg * 1.1);

  // 2. Calculate true cost (Price + Hidden Costs)
  const hiddenCosts = Array.isArray(input?.hiddenCosts) ? input.hiddenCosts : [];
  const hiddenCostTotal = hiddenCosts.reduce((sum: number, item: any) => {
    const cost = item?.estimatedCost ?? item?.amount ?? 25;
    return sum + Number(cost);
  }, 0);
  const trueCost = price + hiddenCostTotal;

  // 3. Score & Factors calculation
  let score = 75;
  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];
  const factors: Array<{ impact: string; label: string; positive: boolean }> = [];

  const riskSignals = Array.isArray(input?.riskSignals) ? input.riskSignals : [];
  const hasCriticalRisk = riskSignals.length > 0;

  if (hasCriticalRisk) {
    score = 35;
    negativeFactors.push("Critical risk signal detected");
    factors.push({ impact: "-40 pts", label: "Critical risk signal detected", positive: false });
  } else if (marketAvg > 0 && price < marketAvg) {
    const savingsPercent = Math.round(((marketAvg - price) / marketAvg) * 100);
    const boost = Math.min(savingsPercent, 20);
    score += boost;
    positiveFactors.push(`Listed ${savingsPercent}% below market average`);
    factors.push({ impact: `+${boost} pts`, label: `Listed ${savingsPercent}% below market average`, positive: true });
  }

  if (input?.hasAccessories) {
    score += 5;
    positiveFactors.push("Complete accessories included");
    factors.push({ impact: "+5 pts", label: "Complete accessories included", positive: true });
  }

  const dealScore = Math.max(0, Math.min(100, score));
  const walkAwayPrice = Math.round(marketAvg * 0.95);

  return {
    listingPrice: price,
    dealScore,
    fairMarketRange: { min: minMarket, max: maxMarket },
    minMarket,
    maxMarket,
    trueCost,
    walkAwayPrice,
    scoreBreakdown: { positiveFactors, negativeFactors },
    factors,
  };
}

export { analyzeDeal as evaluateDeal };