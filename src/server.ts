import express from "express";
import type { Request, Response } from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { SignJWT, jwtVerify } from "jose";
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

app.set("trust proxy", 1);

const PORT = process.env.PORT
  ? Number.parseInt(process.env.PORT, 10)
  : 3000;

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "change-this-secret"
);

const COOKIE_NAME = "dealtough_session";

const STRIPE_SECRET_KEY =
  process.env.STRIPE_SECRET_KEY || "";

const STRIPE_PLUS_PRICE_ID =
  process.env.STRIPE_PLUS_PRICE_ID ||
  process.env.STRIPE_PRICE_ID ||
  "";

const STRIPE_CREDIT_PRICE_ID =
  process.env.STRIPE_CREDIT_PRICE_ID || "";

const APP_URL =
  process.env.APP_URL ||
  "https://dealtough-production.up.railway.app";

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY)
  : null;

async function createSessionToken(
  userId: string
): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(JWT_SECRET);
}

function saveSessionCookie(
  res: Response,
  token: string
): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

async function getSignedInUserId(
  req: Request
): Promise<string | null> {
  const token = req.cookies?.[COOKIE_NAME];

  if (!token || typeof token !== "string") {
    return null;
  }

  try {
    const verified = await jwtVerify(
      token,
      JWT_SECRET
    );

    const userId = verified.payload.userId;

    return typeof userId === "string"
      ? userId
      : null;
  } catch {
    return null;
  }
}

app.use(express.json());
app.use(cookieParser());

// Find the public folder in development and production
const possiblePublicPaths = [
  path.join(process.cwd(), "public"),
  path.join(__dirname, "../public"),
  path.join(__dirname, "public")
];

const publicPath =
  possiblePublicPaths.find((candidate) =>
    fs.existsSync(candidate)
  ) || path.join(process.cwd(), "public");

// Serve the frontend
app.use(express.static(publicPath));

// Railway health check
app.get(
  "/health",
  (_req: Request, res: Response) => {
    res.status(200).send("OK");
  }
);

// Create account
app.post(
  "/api/auth/register",
  async (req: Request, res: Response) => {
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
          error:
            "Email and password are required."
        });
        return;
      }

      if (password.length < 8) {
        res.status(400).json({
          error:
            "Password must be at least 8 characters."
        });
        return;
      }

      const existingUser =
        await prisma.user.findUnique({
          where: { email }
        });

      if (existingUser) {
        res.status(409).json({
          error: "Account already exists."
        });
        return;
      }

      const passwordHash =
        await bcrypt.hash(password, 12);

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          monthlyResetAt: new Date(
            Date.now() +
              30 * 24 * 60 * 60 * 1000
          )
        }
      });

      const token =
        await createSessionToken(user.id);

      saveSessionCookie(res, token);

      res.status(201).json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          plan: user.plan,
          creditBalance: user.creditBalance
        }
      });
    } catch (error) {
      console.error(
        "Registration error:",
        error
      );

      res.status(500).json({
        error: "Unable to create account."
      });
    }
  }
);

// Sign in
app.post(
  "/api/auth/login",
  async (req: Request, res: Response) => {
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
          error:
            "Email and password are required."
        });
        return;
      }

      const user =
        await prisma.user.findUnique({
          where: { email }
        });

      if (!user) {
        res.status(401).json({
          error:
            "Incorrect email or password."
        });
        return;
      }

      const passwordMatches =
        await bcrypt.compare(
          password,
          user.passwordHash
        );

      if (!passwordMatches) {
        res.status(401).json({
          error:
            "Incorrect email or password."
        });
        return;
      }

      const token =
        await createSessionToken(user.id);

      saveSessionCookie(res, token);

      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          plan: user.plan,
          creditBalance: user.creditBalance
        }
      });
    } catch (error) {
      console.error("Login error:", error);

      res.status(500).json({
        error: "Unable to sign in."
      });
    }
  }
);

// Get the currently signed-in account
app.get(
  "/api/auth/me",
  async (req: Request, res: Response) => {
    try {
      const userId =
        await getSignedInUserId(req);

      if (!userId) {
        res.status(401).json({
          error: "Please sign in."
        });
        return;
      }

      const user =
        await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            plan: true,
            monthlyUsage: true,
            monthlyAllowance: true,
            creditBalance: true,
            subscriptionStatus: true
          }
        });

      if (!user) {
        res.status(404).json({
          error: "Account not found."
        });
        return;
      }

      res.json({
        success: true,
        user
      });
    } catch (error) {
      console.error(
        "Account lookup error:",
        error
      );

      res.status(500).json({
        error: "Unable to load account."
      });
    }
  }
);

// DealTough Plus checkout
app.post(
  "/api/checkout/plus",
  async (req: Request, res: Response) => {
    try {
      if (!stripe) {
        res.status(503).json({
          error:
            "Stripe is not configured."
        });
        return;
      }

      if (!STRIPE_PLUS_PRICE_ID) {
        res.status(503).json({
          error:
            "The Plus price ID is missing."
        });
        return;
      }

      const userId =
        await getSignedInUserId(req);

      if (!userId) {
        res.status(401).json({
          error:
            "Please sign in before upgrading."
        });
        return;
      }

      const user =
        await prisma.user.findUnique({
          where: { id: userId }
        });

      if (!user) {
        res.status(404).json({
          error: "Account not found."
        });
        return;
      }

      let stripeCustomerId =
        user.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer =
          await stripe.customers.create({
            email: user.email,
            metadata: {
              dealtoughUserId: user.id
            }
          });

        stripeCustomerId = customer.id;

        await prisma.user.update({
          where: { id: user.id },
          data: {
            stripeCustomerId
          }
        });
      }

      const session =
        await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: stripeCustomerId,
          line_items: [
            {
              price: STRIPE_PLUS_PRICE_ID,
              quantity: 1
            }
          ],
          success_url:
            `${APP_URL}/?payment=success&type=plus`,
          cancel_url:
            `${APP_URL}/?payment=canceled`,
          client_reference_id: user.id,
          metadata: {
            dealtoughUserId: user.id,
            purchaseType: "plus"
          },
          subscription_data: {
            metadata: {
              dealtoughUserId: user.id,
              purchaseType: "plus"
            }
          }
        });

      if (!session.url) {
        throw new Error(
          "Stripe did not return a checkout URL."
        );
      }

      res.json({
        success: true,
        url: session.url
      });
    } catch (error) {
      console.error(
        "Plus checkout error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to start Plus checkout."
      });
    }
  }
);

// Five-analysis credit checkout
app.post(
  "/api/checkout/credits",
  async (req: Request, res: Response) => {
    try {
      if (!stripe) {
        res.status(503).json({
          error:
            "Stripe is not configured."
        });
        return;
      }

      if (!STRIPE_CREDIT_PRICE_ID) {
        res.status(503).json({
          error:
            "The credit price ID is missing."
        });
        return;
      }

      const userId =
        await getSignedInUserId(req);

      if (!userId) {
        res.status(401).json({
          error:
            "Please sign in before buying credits."
        });
        return;
      }

      const user =
        await prisma.user.findUnique({
          where: { id: userId }
        });

      if (!user) {
        res.status(404).json({
          error: "Account not found."
        });
        return;
      }

      let stripeCustomerId =
        user.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer =
          await stripe.customers.create({
            email: user.email,
            metadata: {
              dealtoughUserId: user.id
            }
          });

        stripeCustomerId = customer.id;

        await prisma.user.update({
          where: { id: user.id },
          data: {
            stripeCustomerId
          }
        });
      }

      const session =
        await stripe.checkout.sessions.create({
          mode: "payment",
          customer: stripeCustomerId,
          line_items: [
            {
              price: STRIPE_CREDIT_PRICE_ID,
              quantity: 1
            }
          ],
          success_url:
            `${APP_URL}/?payment=success&type=credits`,
          cancel_url:
            `${APP_URL}/?payment=canceled`,
          client_reference_id: user.id,
          metadata: {
            dealtoughUserId: user.id,
            purchaseType: "credits"
          }
        });

      if (!session.url) {
        throw new Error(
          "Stripe did not return a checkout URL."
        );
      }

      res.json({
        success: true,
        url: session.url
      });
    } catch (error) {
      console.error(
        "Credit checkout error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to start credit checkout."
      });
    }
  }
);

// Deal analysis
app.post(
  "/api/analyze",
  (req: Request, res: Response): void => {
    try {
      const input = req.body;
      const result = analyzeDeal(input);

      res.json(result);
    } catch (error) {
      console.error(
        "Analysis Error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to process deal analysis"
      });
    }
  }
);

// Frontend fallback
app.get(
  "*",
  (_req: Request, res: Response) => {
    const indexPath =
      path.join(publicPath, "index.html");

    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send(
        "index.html not found in public folder"
      );
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server listening on port ${PORT}`
    );
  }
);

export default app;