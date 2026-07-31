export function analyzeDeal(input: any): any {
  const askingPrice = Number(input?.askingPrice ?? input?.price ?? 0);
  const estimatedMarketValue = Number(
    input?.estimatedMarketValue ??
    input?.marketValue ??
    0
  );

  if (!Number.isFinite(askingPrice) || askingPrice <= 0) {
    throw new Error("A valid asking price is required.");
  }

  const comparables = Array.isArray(input?.comparables)
    ? input.comparables
        .map((item: any) => Number(item?.price ?? item))
        .filter((price: number) => Number.isFinite(price) && price > 0)
    : [];

  let marketValue = estimatedMarketValue;

  if (comparables.length > 0) {
    const total = comparables.reduce(
      (sum: number, price: number) => sum + price,
      0
    );

    marketValue = total / comparables.length;
  }

  if (!Number.isFinite(marketValue) || marketValue <= 0) {
    marketValue = askingPrice;
  }

  const hiddenCosts = Array.isArray(input?.hiddenCosts)
    ? input.hiddenCosts
    : [];

  const hiddenCostTotal = hiddenCosts.reduce(
    (sum: number, item: any) => {
      const cost = Number(
        item?.estimatedCost ??
        item?.amount ??
        item ??
        0
      );

      return sum + (Number.isFinite(cost) ? cost : 0);
    },
    0
  );

  const trueCost = askingPrice + hiddenCostTotal;
  const savings = marketValue - trueCost;
  const savingsPercent =
    marketValue > 0 ? (savings / marketValue) * 100 : 0;

  const riskSignals = Array.isArray(input?.riskSignals)
    ? input.riskSignals.filter(Boolean)
    : [];

  let dealScore = 70;

  if (savingsPercent >= 20) {
    dealScore = 95;
  } else if (savingsPercent >= 10) {
    dealScore = 88;
  } else if (savingsPercent >= 5) {
    dealScore = 80;
  } else if (savingsPercent >= 0) {
    dealScore = 72;
  } else if (savingsPercent >= -10) {
    dealScore = 55;
  } else {
    dealScore = 35;
  }

  dealScore -= Math.min(riskSignals.length * 10, 30);
  dealScore = Math.max(0, Math.min(100, Math.round(dealScore)));

  let verdict = "Fair Deal";

  if (dealScore >= 90) {
    verdict = "Excellent Deal";
  } else if (dealScore >= 80) {
    verdict = "Good Deal";
  } else if (dealScore >= 65) {
    verdict = "Fair Deal";
  } else if (dealScore >= 50) {
    verdict = "Negotiate";
  } else {
    verdict = "Walk Away";
  }

  const openingOffer = Math.max(
    0,
    Math.round(Math.min(askingPrice * 0.88, marketValue * 0.82))
  );

  const maxPrice = Math.max(
    openingOffer,
    Math.round(marketValue * 0.95 - hiddenCostTotal)
  );

  const risks =
    riskSignals.length > 0
      ? riskSignals
      : [
          "Condition has not been independently verified",
          "Confirm ownership and title status where applicable",
          "Inspect the item before sending payment"
        ];

  const sellerQuestions = [
    "Why are you selling it?",
    "Are there any known problems or needed repairs?",
    "Do you have maintenance records or receipts?",
    "Is the price negotiable?",
    "Can I inspect and test it before purchasing?"
  ];

  const negotiationMessage =
    `Hi, I’m interested in the item. Based on the condition, ` +
    `likely added costs, and comparable market value, I would be ` +
    `comfortable starting at $${openingOffer.toLocaleString()}. ` +
    `I can move forward promptly if everything checks out during inspection.`;

  return {
    listingPrice: askingPrice,
    askingPrice,
    dealScore,
    score: dealScore,
    verdict,
    marketValue: Math.round(marketValue),
    fairMarketValue: Math.round(marketValue),
    fairMarketRange: {
      min: Math.round(marketValue * 0.9),
      max: Math.round(marketValue * 1.1)
    },
    trueCost: Math.round(trueCost),
    savings: Math.round(savings),
    openingOffer,
    maxPrice,
    maximumPrice: maxPrice,
    walkAwayPrice: maxPrice,
    risks,
    sellerQuestions,
    negotiationMessage,
    confidence:
      comparables.length >= 3
        ? "High"
        : estimatedMarketValue > 0
          ? "Medium"
          : "Low",
    summary:
      savings >= 0
        ? `Estimated to be $${Math.round(savings).toLocaleString()} below market after added costs.`
        : `Estimated to be $${Math.abs(Math.round(savings)).toLocaleString()} above market after added costs.`
  };
}

export { analyzeDeal as evaluateDeal };