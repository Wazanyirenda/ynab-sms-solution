/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SMS PARSERS — Extract transaction data from SMS text.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module handles parsing SMS messages to extract:
 * - Amount (in milliunits for YNAB: ZMW 10.00 → 10000)
 * - Direction (inflow +1 or outflow -1)
 * - Category (by name, resolved to ID at runtime)
 * - Payee (for airtime purchases)
 */

import {
  INCOME_KEYWORDS,
  OUTFLOW_KEYWORDS,
  isBalanceOnlyMessage,
  matchCategoryName,
  matchPayee,
} from "./config.ts";
import { getCategoryIdByName } from "./ynab-lookup.ts";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of parsing an SMS for transaction data.
 */
export interface ParsedTransaction {
  amountMilli: number; // Amount in milliunits (e.g., 10.00 → 10000)
  sign: 1 | -1; // +1 for inflow, -1 for outflow
}

/**
 * Full context extracted from an SMS.
 */
export interface SmsContext {
  parsed: ParsedTransaction | null; // null if we couldn't parse
  isBalanceOnly: boolean; // true if this is just a balance notification
  categoryName?: string; // Category name from config rules
  categoryId?: string; // Category ID from YNAB lookup
  payeeName?: string; // Payee name if we have a confident match
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PARSING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses an SMS and extracts all relevant transaction context.
 * This is the main entry point for SMS parsing.
 *
 * Note: This function uses the YNAB lookup cache. Make sure to call
 * ensureCache() before calling this function.
 *
 * @param text - The full SMS body
 * @returns SmsContext with all extracted data
 */
export function parseSmsContext(text: string): SmsContext {
  // Step 1: Check if this is a balance-only message (not a transaction).
  const isBalanceOnly = isBalanceOnlyMessage(text);

  // Step 2: Try to extract amount and direction.
  const parsed = parseAmount(text);

  // Step 3: Match category rules (by name).
  const categoryName = matchCategoryName(text);

  // Step 4: Look up category ID from cache (if category name matched).
  const categoryId = categoryName ? getCategoryIdByName(categoryName) : undefined;

  // Step 5: Match payee rules (only for airtime/top-up).
  const payeeName = matchPayee(text);

  return {
    parsed,
    isBalanceOnly,
    categoryName,
    categoryId,
    payeeName,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AMOUNT PARSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extracts the transaction amount and direction from SMS text.
 *
 * Looks for patterns like:
 * - "ZMW 10.00"
 * - "ZMW 1,234.56"
 * - "Amount ZMW 50.00"
 *
 * Direction is determined by keywords:
 * - Income: received, credited, deposit, etc.
 * - Outflow: sent to, paid, purchase, etc.
 * - Default: outflow (safer assumption for money leaving)
 *
 * @param text - The SMS body
 * @returns ParsedTransaction or null if parsing failed
 */
export function parseAmount(text: string): ParsedTransaction | null {
  // Look for "ZMW" followed by a number (with optional commas and decimals).
  const amountMatch = text.match(/ZMW\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (!amountMatch) return null;

  // Remove commas and parse as a number.
  const amountStr = amountMatch[1].replace(/,/g, "");
  const amount = Number(amountStr);
  if (!Number.isFinite(amount)) return null;

  // Convert to milliunits (YNAB uses 1000ths: ZMW 10.00 → 10000).
  const amountMilli = Math.round(amount * 1000);
  if (amountMilli === 0) return null;

  // Determine direction based on keywords.
  const lower = text.toLowerCase();
  let sign: 1 | -1 = -1; // Default to outflow (money leaving).

  // Check for income keywords (money coming in).
  if (INCOME_KEYWORDS.some((k) => lower.includes(k))) {
    sign = 1;
  }

  // Check for outflow keywords (money going out).
  // Note: outflow check comes second so it can override income if both appear.
  if (OUTFLOW_KEYWORDS.some((k) => lower.includes(k))) {
    sign = -1;
  }

  return { amountMilli, sign };
}

// ═══════════════════════════════════════════════════════════════════════════
// DATE NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalizes a date string to ISO format.
 * Falls back to current server time if input is missing or invalid.
 *
 * @param input - Date string from the payload (various formats)
 * @returns ISO date string (e.g., "2025-12-24T14:30:00.000Z")
 */
export function normalizeDate(input?: string): string {
  const fallback = new Date();
  if (!input) return fallback.toISOString();

  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback.toISOString();

  return d.toISOString();
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT ID GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a deterministic import ID for YNAB deduplication.
 *
 * YNAB uses import_id to prevent duplicate transactions. We hash:
 * - Sender name
 * - Date (YYYY-MM-DD)
 * - Amount in milliunits
 * - Full SMS text
 *
 * This ensures the same SMS always produces the same import ID.
 *
 * @param input - Components to hash
 * @returns Import ID string (e.g., "sms:a1b2c3d4...")
 */
export async function makeImportId(input: {
  sender: string;
  date: string;
  amountMilli: number;
  text: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  const raw = `${input.sender}|${input.date}|${input.amountMilli}|${input.text}`;

  // Use SHA-256 hash for determinism and collision resistance.
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(raw));

  // Convert to hex string and take first 32 chars.
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `sms:${hex.slice(0, 32)}`;
}
