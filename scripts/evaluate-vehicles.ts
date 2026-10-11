import { readFile } from 'node:fs/promises';
import { evaluateVehicleOutcomes } from '../src/vehicle-evaluation.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: npx tsx scripts/evaluate-vehicles.ts reviewed-outcomes.json');
const rows = JSON.parse(await readFile(path, 'utf8'));
if (!Array.isArray(rows)) throw new Error('Expected an array of documented outcomes');
console.log(JSON.stringify(evaluateVehicleOutcomes(rows), null, 2));
