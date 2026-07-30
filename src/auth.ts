import type { NextFunction, Request, Response } from "express";
import { compare, hash } from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { env, isAuthConfigured } from "./env.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const COOKIE_NAME = "session";
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash);
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(env.jwtSecret());
}

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getSecret());
}

async function verifySession(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// One cookie, whose value we generate ourselves (a JWT — fixed alphabet, no
// special characters) — no real parsing edge cases, so no need for the
// cookie-parser dependency.
function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(";").find((c) => c.trim().startsWith(`${COOKIE_NAME}=`));
  return match ? match.trim().slice(COOKIE_NAME.length + 1) : null;
}

export function setSessionCookie(res: Response, token: string): void {
  const maxAgeSeconds = SESSION_DAYS * 24 * 60 * 60;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isAuthConfigured()) {
    res.status(503).json({ error: "Accounts are not configured" });
    return;
  }
  const token = readSessionCookie(req);
  const userId = token ? await verifySession(token) : null;
  if (!userId) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  req.userId = userId;
  next();
}

// Exposed for the /api/auth/me route, which needs to resolve the user
// without failing the whole request via requireAuth's 401.
export async function getSessionUserId(req: Request): Promise<string | null> {
  const token = readSessionCookie(req);
  return token ? verifySession(token) : null;
}
