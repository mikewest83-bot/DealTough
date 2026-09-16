import { afterEach, describe, expect, it } from "vitest";
import {
  PLUS_MONTHLY_ALLOWANCE,
  effectiveAllowance,
  isTesterEmail,
} from "../src/billing.js";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("isTesterEmail", () => {
  it("is false for everyone when TESTER_EMAILS is unset", () => {
    delete process.env.TESTER_EMAILS;
    expect(isTesterEmail("mike.west83@gmail.com")).toBe(false);
  });

  it("is false for everyone when TESTER_EMAILS is empty", () => {
    process.env.TESTER_EMAILS = "   ";
    expect(isTesterEmail("mike.west83@gmail.com")).toBe(false);
  });

  it("matches a listed address regardless of case or surrounding space", () => {
    process.env.TESTER_EMAILS = "  Tester@Example.COM ,second@example.com";
    expect(isTesterEmail("tester@example.com")).toBe(true);
    expect(isTesterEmail(" TESTER@example.com ")).toBe(true);
    expect(isTesterEmail("second@example.com")).toBe(true);
  });

  it("does not match an address that is merely a substring of a listed one", () => {
    process.env.TESTER_EMAILS = "realtester@example.com";
    expect(isTesterEmail("tester@example.com")).toBe(false);
  });

  it("handles a null or empty email", () => {
    process.env.TESTER_EMAILS = "tester@example.com";
    expect(isTesterEmail(null)).toBe(false);
    expect(isTesterEmail("")).toBe(false);
  });
});

describe("effectiveAllowance", () => {
  it("leaves a non-tester on their stored allowance", () => {
    process.env.TESTER_EMAILS = "tester@example.com";
    expect(effectiveAllowance({ email: "someone@example.com", monthlyAllowance: 2 })).toBe(2);
  });

  it("raises a listed free-tier account to the Plus allowance", () => {
    process.env.TESTER_EMAILS = "tester@example.com";
    expect(effectiveAllowance({ email: "tester@example.com", monthlyAllowance: 2 })).toBe(
      PLUS_MONTHLY_ALLOWANCE,
    );
  });

  // The whole point of Math.max: adding a paying subscriber to the tester list
  // must never cost them allowance they are paying for.
  it("never reduces an allowance that is already higher", () => {
    process.env.TESTER_EMAILS = "tester@example.com";
    expect(effectiveAllowance({ email: "tester@example.com", monthlyAllowance: 100 })).toBe(100);
  });

  it("is a no-op for everyone when the list is unset", () => {
    delete process.env.TESTER_EMAILS;
    expect(effectiveAllowance({ email: "tester@example.com", monthlyAllowance: 2 })).toBe(2);
  });
});
