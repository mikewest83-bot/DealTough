import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { analyzeDeal } from "./engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Resolve public directory dynamically across dev & production build environments
const possiblePublicPaths = [
  path.join(process.cwd(), "public"),
  path.join(__dirname, "../public"),
  path.join(__dirname, "public"),
];

const publicPath = possiblePublicPaths.find((p) => fs.existsSync(p)) || path.join(process.cwd(), "public");

// 1. Serve Static UI Files
app.use(express.static(publicPath));

// 2. Healthcheck Endpoint for Railway
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

// 3. API Endpoint for Deal Analysis
app.post("/api/analyze", (req: Request, res: Response): void => {
  try {
    const input = req.body;
    const result = analyzeDeal(input);
    res.json(result);
  } catch (error) {
    console.error("Analysis Error:", error);
    res.status(500).json({ error: "Failed to process deal analysis" });
  }
});

// 4. Catch-all Root / Frontend Fallback
app.get("*", (_req: Request, res: Response) => {
  const indexPath = path.join(publicPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("index.html not found in public folder");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});

export default app;