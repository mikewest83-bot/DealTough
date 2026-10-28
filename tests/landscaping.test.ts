import { describe, expect, it } from "vitest";
import { estimateLandscaping } from "../src/landscaping.js";

describe("landscaping estimates", () => {
  it("builds a mulch takeoff and installed range", () => {
    const estimate = estimateLandscaping({
      projectType: "mulch",
      areaSqFt: 1000,
      depthIn: 3,
      wastePercent: 10,
    });

    expect(estimate.projectType).toBe("mulch");
    expect(estimate.quantity.cubicYardsToOrder).toBe(10.5);
    expect(estimate.materialTakeoff[0]?.qty).toBe(10.5);
    expect(estimate.installedRange).toMatchObject({ low: 892.5, high: 1575, unit: "yd³" });
    expect(estimate.note).toMatch(/not a binding bid/i);
  });

  it("prices sod from dimensions and adds installation waste", () => {
    const estimate = estimateLandscaping({
      projectType: "sod",
      lengthFt: 50,
      widthFt: 40,
    });

    expect(estimate.areaSqFt).toBe(2000);
    expect(estimate.quantity.sodSqFtToOrder).toBe(2100);
    expect(estimate.installedRange.low).toBe(3150);
    expect(estimate.installedRange.high).toBe(6825);
    expect(estimate.notIncluded).toContain("major grading");
  });

  it("supports every advertised project type", () => {
    const samples = [
      { projectType: "pine_straw", areaSqFt: 900 },
      { projectType: "pavers", areaSqFt: 200 },
      { projectType: "planting", plantCount: 12, plantSize: "medium" },
      { projectType: "cleanup", crewHours: 8, disposalLoads: 2 },
      { projectType: "irrigation", areaSqFt: 5000 },
      { projectType: "lawn_service", areaSqFt: 8000, visits: 4 },
    ];

    for (const sample of samples) {
      const estimate = estimateLandscaping(sample);
      expect(estimate.installedRange.high).toBeGreaterThan(estimate.installedRange.low);
    }
  });

  it("rejects an area project without measurements", () => {
    expect(() => estimateLandscaping({ projectType: "mulch" })).toThrow(/areaSqFt/);
  });

  it("rejects an unknown project type", () => {
    expect(() => estimateLandscaping({ projectType: "pool" })).toThrow(/projectType must be one of/);
  });
});
