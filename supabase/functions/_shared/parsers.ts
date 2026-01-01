/**
 * PARSERS — Utility functions for data normalization.
 */

/**
 * Normalizes a date string to ISO format.
 * Falls back to current time if input is missing or invalid.
 */
export function normalizeDate(input?: string): string {
  const fallback = new Date();
  if (!input) return fallback.toISOString();

  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback.toISOString();

  return d.toISOString();
}

/**
 * Creates a deterministic import ID for YNAB deduplication.
 *
 * Hashes sender + full timestamp + amount + SMS text.
 * Using full timestamp allows same-amount transactions at different
 * times to be distinct, while deduplicating identical SMS.
 */
export async function makeImportId(input: {
  sender: string;
  date: string;
  amountMilli: number;
  text: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  const raw =
    `${input.sender}|${input.date}|${input.amountMilli}|${input.text}`;

  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(raw));

  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `sms:${hex.slice(0, 32)}`;
}
