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
  comparables?: Array<{ price: number; similarity: number; sold?: boolean }>;
  hiddenCosts?: Array<{ label: string; amount?: number }>;
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
  factors: Array<{ impact: string; label: string; positive: boolean }>;
}

export function analyzeDeal(input: ListingInput): ValuationResult {
  const price = input.askingPrice || 0;
  
  // Calculate average market price from comparables, or fallback
  let marketAvg = price;
  if (input.comparables && input.comparables.length > 0) {
    const sum = input.comparables.reduce((acc, c) => acc + c.price, 0);
    marketAvg = sum / input.comparables.length;
  }

  const minMarket = Math.round(marketAvg * 0.9);
  const maxMarket = Math.round(marketAvg * 1.1);

  // Calculate hidden costs sum
  const hiddenCostTotal = (input.hiddenCosts || []).reduce(
    (sum, item) => sum + (item.amount || 25),
    0
  );
  const trueCost = price + hiddenCostTotal;

  // Base scoring calculation
  let score = 75;
  const factors: Array<{ impact: string; label: string; positive: boolean }> = [];

  // Critical risk check
  const hasCriticalRisk = input.riskSignals && input.riskSignals.length > 0;

  if (hasCriticalRisk) {
    score = Math.min(score, 40);
    factors.push({
      impact: "-35 pts",
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
  const walkAwayPrice = Math.round(price * 1.15);

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