export interface ListingInput {
  price: number;
  condition: string;
  hasAccessories: boolean;
}

export interface ValuationResult {
  listingPrice: number;
  minMarket: number;
  maxMarket: number;
  dealScore: number;
  factors: { impact: string; label: string; positive: boolean }[];
}

export function evaluateDeal(input: ListingInput, marketAvg: number): ValuationResult {
  const minMarket = Math.round(marketAvg * 0.9);
  const maxMarket = Math.round(marketAvg * 1.1);

  let score = 75; // Baseline fair market score
  const factors = [];

  // Price factor calculation
  if (input.price < marketAvg) {
    const savingsPercent = Math.round(((marketAvg - input.price) / marketAvg) * 100);
    score += Math.min(savingsPercent, 15);
    factors.push({
      impact: `+${Math.min(savingsPercent, 15)} pts`,
      label: `Listed ${savingsPercent}% below market average`,
      positive: true,
    });
  } else if (input.price > marketAvg) {
    score -= 10;
    factors.push({
      impact: `-10 pts`,
      label: `Priced above market average`,
      positive: false,
    });
  }

  // Accessories factor
  if (input.hasAccessories) {
    score += 5;
    factors.push({
      impact: `+5 pts`,
      label: `Complete accessories included`,
      positive: true,
    });
  }

  // Cap score between 0 and 100
  score = Math.max(0, Math.min(100, score));

  return {
    listingPrice: input.price,
    minMarket,
    maxMarket,
    dealScore: score,
    factors,
  };
}