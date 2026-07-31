import express from "express";
import type { Request, Response } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";
import { webcrypto } from "node:crypto";

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { analyzeDeal } from "./engine.js";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const prisma = new PrismaClient();

const PORT = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : 3000;

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "change-this-secret"
);

const COOKIE_NAME = "dealtough_session";

async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(JWT_SECRET);
}

function saveSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

app.use(express.json());
app.use(cookieParser());

// Resolve the public directory in development and production
const possiblePublicPaths = [
  path.join(process.cwd(), "public"),
  path.join(__dirname, "../public"),
  path.join(__dirname, "public")
];

const publicPath =
  possiblePublicPaths.find((p) => fs.existsSync(p)) ||
  path.join(process.cwd(), "public");

// Serve frontend files
app.use(express.static(publicPath));

// Railway health check
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

// Create account
app.post("/api/auth/register", async (req: Request, res: Response) => {
  try {
    const email =
      typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    const password =
      typeof req.body.password === "string"
        ? req.body.password
        : "";

    if (!email || !password) {
      res.status(400).json({
        error: "Email and password are required."
      });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({
        error: "Password must be at least 8 characters."
      });
      return;
    }

    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      res.status(409).json({
        error: "Account already exists."
      });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        monthlyResetAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        )
      }
    });

    const token = await createSessionToken(user.id);
    saveSessionCookie(res, token);

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan
      }
    });
  } catch (error) {
    console.error("Registration error:", error);

    res.status(500).json({
      error: "Unable to create account."
    });
  }
});

// Sign in
app.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const email =
      typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    const password =
      typeof req.body.password === "string"
        ? req.body.password
        : "";

    if (!email || !password) {
      res.status(400).json({
        error: "Email and password are required."
      });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      res.status(401).json({
        error: "Incorrect email or password."
      });
      return;
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatches) {
      res.status(401).json({
        error: "Incorrect email or password."
      });
      return;
    }

    const token = await createSessionToken(user.id);
    saveSessionCookie(res, token);

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan
      }
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      error: "Unable to sign in."
    });
  }
});

// Deal analysis
app.post("/api/analyze", (req: Request, res: Response): void => {
  try {
    const input = req.body;
    const result = analyzeDeal(input);

    res.json(result);
  } catch (error) {
    console.error("Analysis Error:", error);

    res.status(500).json({
      error: "Failed to process deal analysis"
    });
  }
});

// Frontend fallback
app.get("*", (_req: Request, res: Response) => {
  const indexPath = path.join(publicPath, "index.html");

  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send(
      "index.html not found in public folder"
    );
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});

export default app;