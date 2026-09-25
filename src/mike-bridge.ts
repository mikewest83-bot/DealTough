import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  isAnthropicConfigured,
  isAuthConfigured,
  isDbConfigured,
  isEbayConfigured,
  isStripeConfigured,
} from "./env.js";

const MIN_TOKEN_BYTES = 32;

function sameToken(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireMikeBridge(req: Request, res: Response, next: NextFunction): void {
  const expected = String(process.env.MIKE_BRIDGE_TOKEN || "");
  if (Buffer.byteLength(expected) < MIN_TOKEN_BYTES) {
    res.status(503).json({ error: "bridge_not_configured" });
    return;
  }
  const authorization = String(req.get("authorization") || "");
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!sameToken(supplied, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function dealToughBridgeStatus() {
  return {
    schemaVersion: 1,
    service: "dealtough",
    ok: true,
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    capabilities: {
      dealAnalysis: true,
      aiExtraction: isAnthropicConfigured(),
      marketComparables: isEbayConfigured(),
      accounts: isAuthConfigured() && isDbConfigured(),
      billing: isStripeConfigured(),
    },
    dependencies: {
      database: isDbConfigured(),
      anthropic: isAnthropicConfigured(),
      ebay: isEbayConfigured(),
      stripe: isStripeConfigured(),
    },
  };
}
