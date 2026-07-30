import express from "express";
import { analyzeDeal } from "./engine.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/api/v1/deals/analyze", (req, res) => {
  try {
    const report = analyzeDeal(req.body);
    res.status(200).json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    res.status(400).json({ error: message });
  }
});

app.listen(4000, () => {
  console.log("DealTough API listening on http://localhost:4000");
});
