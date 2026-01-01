/**
 * CONFIGURATION — Map SMS senders to YNAB account names.
 *
 * Edit this file to match your SMS senders and YNAB account names.
 * Use the exact account names from your YNAB budget.
 */

// Maps SMS sender names (lowercased) to your YNAB account names
export const SENDER_TO_ACCOUNT: Record<string, string> = {
  // Mobile Money providers
  airtelmoney: "Airtel Money",
  momo: "MTN MoMo",
  "115": "Zamtel Money",

  // Banks — update to match YOUR YNAB account names
  absa: "Absa Current",
  absa_zm: "Absa Current",
  stanchart: "Stanchart Current",
  stanchartzm: "Stanchart Current",
};

/**
 * Account ending hints from environment variable.
 *
 * Some banks include "account ending XXXX" in SMS. This overrides sender mapping.
 * Configure via Supabase secrets to keep your account numbers private:
 *
 *   supabase secrets set ACCOUNT_ENDINGS='{"1234":"Savings Account","5678":"Current Account"}'
 */
function parseAccountEndings(): Record<string, string> {
  const raw = Deno.env.get("ACCOUNT_ENDINGS");
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

export const ACCOUNT_ENDING_HINTS: Record<string, string> =
  parseAccountEndings();

// Fallback account for unmatched senders
export const FALLBACK_ACCOUNT_NAME = "Unknown Imports";

/**
 * Gets the YNAB account name for a given SMS sender.
 */
export function getAccountNameBySender(sender: string): string | undefined {
  return SENDER_TO_ACCOUNT[sender.toLowerCase()];
}

/**
 * Gets the YNAB account name for a given account ending.
 */
export function getAccountNameByEnding(ending: string): string | undefined {
  return ACCOUNT_ENDING_HINTS[ending];
}
