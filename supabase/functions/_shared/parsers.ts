/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PARSERS — Utility functions for data normalization.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module contains utility functions that don't depend on AI:
 * - Date normalization
 * - Import ID generation (for deduplication)
 *
 * The actual SMS parsing is now handled by Gemini AI (see gemini.ts).
 */

// ═══════════════════════════════════════════════════════════════════════════
// DATE NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalizes a date string to ISO format.
 * Falls back to current server time if input is missing or invalid.
 *
 * Handles various date formats that might come from iOS Shortcuts:
 * - "12/30/25, 14:30"
 * - "2025-12-30T14:30:00Z"
 * - "Dec 30, 2025"
 *
 * @param input - Date string from the payload (various formats)
 * @returns ISO date string (e.g., "2025-12-30T14:30:00.000Z")
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
 * - Full timestamp (ISO format with time, not just date!)
 * - Amount in milliunits
 * - Full SMS text
 *
 * IMPORTANT: We use the full timestamp (including time) because some banks
 * like Absa send generic SMS without unique transaction IDs. If we only used
 * the date (YYYY-MM-DD), two K100 transfers on the same day would have
 * identical hashes and YNAB would reject the second as a "duplicate".
 *
 * With full timestamp:
 * - Two transfers at 18:05 and 18:09 → Different import_id → Both created ✅
 * - Same SMS forwarded twice at 18:09:07 → Same import_id → Deduplicated ✅
 *
 * @param input - Components to hash
 * @returns Import ID string (e.g., "sms:a1b2c3d4...")
 */
export async function makeImportId(input: {
  sender: string;
  date: string; // Full ISO timestamp (e.g., "2026-01-01T18:09:07.000Z")
  amountMilli: number;
  text: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  // Include full timestamp for uniqueness — allows same-amount transactions
  // at different times to be distinct while deduplicating true duplicates
  const raw =
    `${input.sender}|${input.date}|${input.amountMilli}|${input.text}`;

  // Use SHA-256 hash for determinism and collision resistance.
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(raw));

  // Convert to hex string and take first 32 chars.
  // YNAB import_id has a max length, so we truncate.
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `sms:${hex.slice(0, 32)}`;
}
