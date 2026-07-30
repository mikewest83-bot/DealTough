import type { DealCategory } from "./types.js";

export const WEIGHTS = {
  value: 35,
  risk: 20,
  trueCost: 15,
  negotiation: 10,
  market: 10,
  confidence: 10,
} as const;

export const CATEGORY_CONFIG: Record<DealCategory, {
  conditionDiscounts: Record<string, number>;
  negotiationFloorPercent: number;
  defaultHiddenCostRate: number;
  volatilityPenalty: number;
}> = {
  vehicle: {
    conditionDiscounts: { new: 0, like_new: 0.03, good: 0.08, fair: 0.18, poor: 0.35, unknown: 0.14 },
    negotiationFloorPercent: 0.78,
    defaultHiddenCostRate: 0.07,
    volatilityPenalty: 0.02,
  },
  electronics: {
    conditionDiscounts: { new: 0, like_new: 0.08, good: 0.18, fair: 0.32, poor: 0.50, unknown: 0.25 },
    negotiationFloorPercent: 0.72,
    defaultHiddenCostRate: 0.03,
    volatilityPenalty: 0.06,
  },
  tools: {
    conditionDiscounts: { new: 0, like_new: 0.05, good: 0.13, fair: 0.27, poor: 0.45, unknown: 0.20 },
    negotiationFloorPercent: 0.72,
    defaultHiddenCostRate: 0.04,
    volatilityPenalty: 0.03,
  },
  furniture: {
    conditionDiscounts: { new: 0, like_new: 0.12, good: 0.28, fair: 0.48, poor: 0.70, unknown: 0.35 },
    negotiationFloorPercent: 0.60,
    defaultHiddenCostRate: 0.08,
    volatilityPenalty: 0.07,
  },
  outdoor_equipment: {
    conditionDiscounts: { new: 0, like_new: 0.06, good: 0.15, fair: 0.30, poor: 0.50, unknown: 0.22 },
    negotiationFloorPercent: 0.70,
    defaultHiddenCostRate: 0.06,
    volatilityPenalty: 0.04,
  },
};
