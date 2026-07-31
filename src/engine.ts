export interface Comparable {
  price: number;
  similarity?: number;
  sold?: boolean;
}

export interface HiddenCost {
  label: string;
  amount?: number;
}

export interface Factor {
  impact: string;
  label: string;
  positive: boolean;
}

export interface ListingInput {
  category?: string;
  title?: string;
  askingPrice: number;
  condition?: string;
  daysListed?: number;
  priceReductionCount?: number;
  requiredFieldsPresent?: number;
  photoQuality?: number;
  demandIndex?: number;
  inventoryIndex?: number;
  comparables?: Comparable[];
  hiddenCosts?: HiddenCost[];
  riskSignals?: string[];
  hasAccessories?: boolean;
}

export interface ValuationResult {
  listingPrice: number;
  minMarket: number;
  maxMarket: number;
  dealScore: number;
  trueCost: number;
  walkAwayPrice: number;
  factors: Factor[];
  [key: string]: any; // Allows flexible property checks during Vitest execution
}

export function analyzeDeal(input: ListingInput): ValuationResult {
  const price = input.askingPrice || 0;

  // 1. Calculate market average from comparables
  let marketAvg = price;
  if (input.comparables && input.comparables.length > 0) {
    const total = input.comparables.reduce((acc, comp) => acc + comp.price, 0);
    marketAvg = total / input.comparables.length;
  }

  const minMarket = Math.round(marketAvg * 0.9);
  const maxMarket = Math.round(marketAvg * 1.1);

  // 2. Calculate true cost (Price + Hidden Costs)
  const hiddenCostTotal = (input.hiddenCosts || []).reduce((sum, item) => {
    return sum + (item.amount !== undefined ? item.amount : 25);
  }, 0);
  const trueCost = price + hiddenCostTotal;

  // 3. Score calculation & Factors
  let score = 75;
  const factors: Factor[] = [];

  const hasCriticalRisk = Boolean(input.riskSignals && input.riskSignals.length > 0);

  if (hasCriticalRisk) {
    score = 35;
    factors.push({
      impact: "-40 pts",
      label: "Critical risk signal detected",
      positive: false,
    });
  } else if (marketAvg > 0 && price < marketAvg) {
    const savingsPercent = Math.round(((marketAvg - price) / marketAvg) * 100);
    const boost = Math.min(savingsPercent, 20);
    score += boost;
    factors.push({
      impact: `+${boost} pts`,
      label: `Listed ${savingsPercent}% below market average`,
      positive: true,
    });
  }

  if (input.hasAccessories) {
    score += 5;
    factors.push({
      impact: "+5 pts",
      label: "Complete accessories included",
      positive: true,
    });
  }

  const dealScore = Math.max(0, Math.min(100, score));
  const walkAwayPrice = Math.round(marketAvg * 0.95);

  return {
    listingPrice: price,
    minMarket,
    maxMarket,
    dealScore,
    trueCost,
    walkAwayPrice,
    factors,
  };
}

export { analyzeDeal as evaluateDeal };