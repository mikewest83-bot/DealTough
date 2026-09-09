import fs from 'node:fs';

const file = 'src/engine.ts';
let source = fs.readFileSync(file, 'utf8');

const start = source.indexOf('// An asking price is one seller\'s opinion; a sold price is what two people');
const end = source.indexOf('\nfunction verdictFor(', start);
if (start < 0 || end < 0) throw new Error('[evidence-confidence] confidence block boundary not found');

const replacement = `// Confidence is evidence confidence, not a generic completeness score.\n// Active listings show what sellers hope to get; completed sales show what\n// buyers actually paid. A large all-active sample is useful for direction, but\n// it must never look as trustworthy as a smaller set with verified sales.\nfunction calculateConfidence(\n  input: DealInput,\n  comparableCount: number,\n  activeShare: number,\n  suspectComparables: boolean,\n  valuationBasis: "comparables" | "unknown",\n): number {\n  if (valuationBasis === "unknown") return 2.5;\n\n  const active = clamp(activeShare, 0, 1);\n  const soldShare = 1 - active;\n\n  // Quantity matters, but only after evidence type. Forty active asking prices\n  // are not forty verified transactions.\n  const quantity = clamp(comparableCount / 10, 0, 1);\n  const transactionEvidence = 0.25 + (0.75 * soldShare);\n  const compScore = 5 * quantity * transactionEvidence;\n\n  // These refine confidence, but cannot overpower weak market evidence.\n  const completeness = clamp(input.requiredFieldsPresent ?? 0.65, 0, 1) * 1.5;\n  const photos = clamp(input.photoQuality ?? 0.6, 0, 1) * 1.0;\n  const conditionKnown = input.condition && input.condition !== "unknown" ? 0.75 : 0.25;\n  const sellerEvidence =\n    input.sellerRating != null && input.sellerReviewCount != null ? 0.75 : 0.25;\n\n  let raw = compScore + completeness + photos + conditionKnown + sellerEvidence;\n  if (suspectComparables) raw *= 0.55;\n\n  // Hard ceilings make the number intuitive. No completed sales means the\n  // valuation is provisional regardless of how many active listings exist.\n  if (active >= 0.995) raw = Math.min(raw, 3.5);\n  else if (active >= 0.90) raw = Math.min(raw, 4.5);\n  else if (active >= 0.75) raw = Math.min(raw, 5.5);\n\n  // Tiny samples remain weak even when one happens to be sold.\n  if (comparableCount === 1) raw = Math.min(raw, 2.5);\n  else if (comparableCount === 2) raw = Math.min(raw, 3.5);\n\n  return clamp(raw, 0, 10);\n}\n`;

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(file, source);
console.log('[evidence-confidence] sold-vs-active evidence now drives valuation confidence with hard ceilings');
