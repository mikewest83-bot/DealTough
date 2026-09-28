// Vehicle-specific evidence for the listing analyzer.
//
// 1. VIN decoding (free, NHTSA vPIC): turns a VIN found in the listing into the
//    exact year / make / model / trim, so the comparable search looks for that
//    vehicle instead of every F-150 ever listed.
// 2. VinAudit market value (paid, off unless VINAUDIT_API_KEY is set): a
//    VIN-exact, mileage-adjusted value from dealer listings. When it answers
//    with enough listings behind it, it replaces the eBay vehicle comparables,
//    which are sparse and noisy for cars.
//
// Every call here is best-effort: a timeout, error or missing key returns null
// and the analysis carries on exactly as it did before this file existed.

import { log } from "./log.js";
import type { Comparable } from "./types.js";

type Fetch = typeof fetch;

const VPIC_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";
const VINAUDIT_URL = "https://marketvalue.vinaudit.com/getmarketvalue.php";
const TIMEOUT_MS = 8000;
// VinAudit's number is only trusted when enough listings stand behind it.
export const VINAUDIT_MIN_COUNT = 10;

// ---------------------------------------------------------------- VIN parsing

const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** True when a 17-character VIN passes the North American check digit. */
export function isValidVin(vin: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /[0-9]/.test(ch) ? Number(ch) : TRANSLIT[ch];
    if (value === undefined) return false;
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const check = remainder === 10 ? "X" : String(remainder);
  return vin[8] === check;
}

/** First valid VIN in free text, or null. Only check-digit-valid VINs count. */
export function findVin(text: string): string | null {
  const candidates = String(text || "").toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || [];
  for (const candidate of candidates) if (isValidVin(candidate)) return candidate;
  return null;
}

/** Odometer reading from listing text ("140k miles", "140,000 mi", "Mileage: 92500"). */
export function findMileage(text: string): number | null {
  const t = String(text || "").toLowerCase();
  const patterns = [
    /(\d{1,3}(?:,\d{3})+|\d{2,6})\s*(k)?\s*(?:miles|mi\b)/,
    /(?:mileage|odometer)\s*[:\-]?\s*(\d{1,3}(?:,\d{3})+|\d{2,6})\s*(k)?\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let n = Number(m[1].replace(/,/g, ""));
    if (m[2] === "k") n *= 1000;
    if (Number.isFinite(n) && n >= 100 && n <= 999_999) return Math.round(n);
  }
  return null;
}

// ---------------------------------------------------------------- NHTSA vPIC

export interface DecodedVin {
  vin: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  series?: string;
  bodyClass?: string;
  driveType?: string;
}

const decodeCache = new Map<string, DecodedVin | null>();

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bF-(\d)/gi, "F-$1");
}

/** Decode a VIN with NHTSA's free vPIC service. Null on any failure. */
export async function decodeVin(vin: string, fetchImpl: Fetch = fetch): Promise<DecodedVin | null> {
  if (decodeCache.has(vin)) return decodeCache.get(vin) ?? null;
  try {
    const res = await fetchImpl(`${VPIC_URL}/${encodeURIComponent(vin)}?format=json`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`vPIC ${res.status}`);
    const body = (await res.json()) as { Results?: Array<Record<string, string>> };
    const r = body.Results?.[0];
    const year = Number(r?.ModelYear);
    const decoded: DecodedVin | null =
      r && r.Make && r.Model && Number.isFinite(year) && year > 1980
        ? {
            vin,
            year,
            make: titleCase(r.Make),
            model: r.Model,
            trim: r.Trim || undefined,
            series: r.Series || undefined,
            bodyClass: r.BodyClass || undefined,
            driveType: r.DriveType || undefined,
          }
        : null;
    decodeCache.set(vin, decoded);
    return decoded;
  } catch (error) {
    log.warn("vehicle.vin_decode_failed", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** "2015 Ford F-150 XLT" — the search title for comparable lookups. */
export function vehicleSearchTitle(d: DecodedVin): string {
  return [d.year, d.make, d.model, d.trim || d.series].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- VinAudit

export interface VinAuditValue {
  vehicle?: string;
  count: number;
  mean: number;
  below: number;
  above: number;
  certainty?: number;
  mileage?: number;
}

export const isVinAuditEnabled = (): boolean => Boolean(process.env.VINAUDIT_API_KEY);

/** VIN-exact, mileage-adjusted market value from VinAudit. Null when off or on any failure. */
export async function fetchVinAuditValue(
  vin: string,
  mileage: number | null,
  fetchImpl: Fetch = fetch,
): Promise<VinAuditValue | null> {
  const key = process.env.VINAUDIT_API_KEY;
  if (!key) return null;
  try {
    const params = new URLSearchParams({
      key,
      vin,
      format: "json",
      period: "90",
      mileage: mileage ? String(mileage) : "average",
    });
    const res = await fetchImpl(`${VINAUDIT_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`VinAudit ${res.status}`);
    const body = (await res.json()) as {
      success?: boolean; vehicle?: string; count?: number; mean?: number; certainty?: number; mileage?: number;
      prices?: { average?: number; below?: number; above?: number };
    };
    const mean = Number(body.prices?.average ?? body.mean);
    const below = Number(body.prices?.below);
    const above = Number(body.prices?.above);
    const count = Number(body.count);
    if (!body.success || !(mean > 0) || !(count > 0)) return null;
    return {
      vehicle: body.vehicle,
      count,
      mean,
      below: below > 0 ? below : mean,
      above: above > 0 ? above : mean,
      certainty: Number.isFinite(Number(body.certainty)) ? Number(body.certainty) : undefined,
      mileage: Number.isFinite(Number(body.mileage)) ? Number(body.mileage) : undefined,
    };
  } catch (error) {
    // Never log the key: only the message.
    log.warn("vehicle.vinaudit_failed", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Turn a VinAudit value into comparables for the engine. The average is
 * counted twice so the weighted median lands on it; below/above keep the
 * spread honest. They are marked as listings (sold: false) because VinAudit
 * values come from dealer listings, so the engine's asking-price allowance
 * still applies — which also moves a dealer retail figure toward a private sale.
 */
export function vinAuditComparables(v: VinAuditValue): Comparable[] {
  const point = (price: number): Comparable => ({ price, similarity: 1, source: "vinaudit", sold: false });
  return [point(v.below), point(v.mean), point(v.mean), point(v.above)];
}
