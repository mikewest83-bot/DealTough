import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDeal } from "./engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// 1. Healthcheck Route for Railway Deployment
app.get("/health", (req: Request, res: Response) => {
  res.status(200).send("OK");
});

// 2. Serve static UI assets from public folder
app.use(express.static(path.join(__dirname, "../public")));

// 3. API Endpoint for Deal Analysis
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

// 4. Fallback route to serve frontend
app.get("*", (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Bind to 0.0.0.0 so Railway container networking can reach it
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;