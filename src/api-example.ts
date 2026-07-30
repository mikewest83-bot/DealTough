import express from "express";
import { analyzeDeal } from "./engine.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, engineVersion: "DTE-1.0" });
});

app.post("/api/v1/deals/analyze", (req, res) => {
  try {
    const report = analyzeDeal(req.body);
    res.status(200).json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    res.status(400).json({ error: message });
  }
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, "0.0.0.0", () => {
  console.log(`DealTough API listening on port ${port}`);
});
