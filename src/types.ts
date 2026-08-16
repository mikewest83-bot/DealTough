export type DealCategory =
  | "vehicle"
  | "electronics"
  | "tools"
  | "furniture"
  | "outdoor_equipment";

export type Condition =
  | "new"
  | "like_new"
  | "good"
  | "fair"
  | "poor"
  | "unknown";

export type RiskSeverity = "low" | "medium" | "high" | "critical";

export interface Comparable {
  price: number;
  similarity?: number; // 0..1
  source?: string;
  sold?: boolean;
  distanceMiles?: number;
  condition?: Condition;
}

export interface CostItem {
  label: string;
  amount: number;
  certainty?: number; // 0..1
  required?: boolean;
}

export interface RiskSignal {
  code: string;
  label: string;
  severity: RiskSeverity;
  evidence?: string;
}

export interface DealInput {
  category: DealCategory;
  title: string;
  askingPrice: number;
  condition?: Condition;
  location?: string;
  description?: string;
  daysListed?: number;
  priceReductionCount?: number;
  sellerRating?: number; // 0..5
  sellerReviewCount?: number;
  comparables: Comparable[];
  hiddenCosts?: CostItem[];
  riskSignals?: RiskSignal[];
  requiredFieldsPresent?: number; // 0..1
  photoQuality?: number; // 0..1
  demandIndex?: number; // 0..1
  inventoryIndex?: number; // 0..1, higher means more supply
}

export interface ScoreBreakdown {
  value: number;       // /35
  risk: number;        // /20
  trueCost: number;    // /15
  negotiation: number; // /10
  market: number;      // /10
  confidence: number;  // /10
}

export interface DealRecommendation {
  dealScore: number;
  verdict:
    | "Exceptional Deal"
    | "Excellent Deal"
    | "Great Buy"
    | "Good Deal"
    | "Fair Deal"
    | "High Risk"
    | "Walk Away"
    | "Insufficient Data";
  // "comparables" means fairMarketValue was derived from real comparable
  // prices. "unknown" means no usable comparables were supplied, so
  // fairMarketValue (and everything derived from it) is not a valuation --
  // see the zero-comparable branch of estimateMarketValue in engine.ts.
  valuationBasis: "comparables" | "unknown";
  fairMarketValue: number;
  goodDealPrice: number;
  greatDealPrice: number;
  trueCost: number;
  estimatedSavings: number;
  openingOffer: number;
  targetPrice: number;
  walkAwayPrice: number;
  confidencePercent: number;
  riskLevel: "Low" | "Moderate" | "High" | "Critical";
  breakdown: ScoreBreakdown;
  reasons: string[];
  topRisks: string[];
  sellerQuestions: string[];
  negotiationMessage: string;
  assumptions: string[];
  engineVersion: "DTE-1.1";
}
