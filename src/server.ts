import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { analyzeDeal } from "./engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static UI assets from public folder
app.use(express.static(path.join(__dirname, "../public")));

// API Endpoint for Deal Analysis
app.post("/api/analyze", async (req: Request, res: Response): Promise<void> => {
  try {
    const input = req.body;
    const result = analyzeDeal(input);
    res.json(result);
  } catch (error) {
    console.error("Analysis Error:", error);
    res.status(500).json({ error: "Failed to process deal analysis" });
  }
});

// Fallback to serve frontend
app.get("*", (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;