import { analyzeDeal } from "../src/index.js";

const report = analyzeDeal({
  category: "vehicle",
  title: "2017 BMW X5 xDrive35i",
  askingPrice: 10900,
  condition: "good",
  daysListed: 32,
  priceReductionCount: 1,
  sellerRating: 4.7,
  sellerReviewCount: 18,
  requiredFieldsPresent: 0.85,
  photoQuality: 0.9,
  demandIndex: 0.62,
  inventoryIndex: 0.58,
  comparables: [
    { price: 13400, similarity: 0.92, sold: true, distanceMiles: 25 },
    { price: 12950, similarity: 0.88, sold: true, distanceMiles: 42 },
    { price: 13900, similarity: 0.81, sold: false, distanceMiles: 15 },
    { price: 12500, similarity: 0.79, sold: true, distanceMiles: 80 },
  ],
  hiddenCosts: [
    { label: "Pre-purchase inspection", amount: 250, required: true },
    { label: "Immediate maintenance reserve", amount: 600, certainty: 0.7 },
  ],
  riskSignals: [
    {
      code: "SERVICE_HISTORY_PARTIAL",
      label: "Partial service history",
      severity: "medium",
      evidence: "Seller has some receipts but no complete maintenance file",
    },
  ],
});

console.log(JSON.stringify(report, null, 2));
