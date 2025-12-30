/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFIGURATION FILE — Map SMS senders to YNAB account NAMES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file contains the mapping between SMS senders and your YNAB accounts.
 * The AI (Gemini) handles the parsing logic — this file just tells it WHERE
 * to route the transactions.
 *
 * NO MORE UUIDs! Just use the human-readable names from your YNAB budget.
 * The system will automatically look up the IDs at runtime.
 */

// ═══════════════════════════════════════════════════════════════════════════
// SENDER → ACCOUNT NAME MAPPING
// ═══════════════════════════════════════════════════════════════════════════
// Maps SMS sender names to your YNAB account NAMES (not IDs).
// The key is the SMS sender (lowercased), the value is the exact YNAB account name.
//
// Example: If your YNAB has an account called "Airtel Money", and SMS comes
// from "AirtelMoney", add: "airtelmoney": "Airtel Money"

export const SENDER_TO_ACCOUNT: Record<string, string> = {
  // Mobile Money providers
  "airtelmoney": "Airtel Money",
  "momo": "MTN MoMo",
  "115": "Zamtel Money",

  // Banks — update these to match YOUR YNAB account names
  "absa": "Absa Current",
  "absa_zm": "Absa Current",
  "stanchart": "Stanchart Current",
  "stanchartzm": "Stanchart Current",
};

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNT ENDING HINTS (from environment variable)
// ═══════════════════════════════════════════════════════════════════════════
// Some bank SMS includes "account ending XXXX". This overrides sender mapping.
// Maps the last 4 digits to your YNAB account NAME.
//
// Set via Supabase secret (keeps your account numbers private!):
//   supabase secrets set ACCOUNT_ENDINGS='{"4983":"Absa Current","0878":"Absa Savings"}'
//
// Or in .env.local for local development:
//   ACCOUNT_ENDINGS={"4983":"Absa Current","0878":"Absa Savings"}

/**
 * Parses the ACCOUNT_ENDINGS environment variable.
 * Returns an empty object if not set or invalid JSON.
 */
function parseAccountEndings(): Record<string, string> {
  const raw = Deno.env.get("ACCOUNT_ENDINGS");
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    // Validate it's an object with string values
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
    console.warn("ACCOUNT_ENDINGS is not a valid object, ignoring");
    return {};
  } catch (err) {
    console.warn("Failed to parse ACCOUNT_ENDINGS JSON:", err);
    return {};
  }
}

// Parse once at module load (cached for the function's lifetime)
export const ACCOUNT_ENDING_HINTS: Record<string, string> =
  parseAccountEndings();

// ═══════════════════════════════════════════════════════════════════════════
// FALLBACK ACCOUNT NAME
// ═══════════════════════════════════════════════════════════════════════════
// If we can't match a sender, we'll create/use this account as a catch-all inbox.
// You can review transactions here and manually move them to the correct account.

export const FALLBACK_ACCOUNT_NAME = "Unknown Imports";

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gets the YNAB account NAME for a given SMS sender.
 * Returns undefined if sender is not mapped.
 *
 * @param sender - The SMS sender name (e.g., "AirtelMoney")
 * @returns The YNAB account name or undefined
 */
export function getAccountNameBySender(sender: string): string | undefined {
  return SENDER_TO_ACCOUNT[sender.toLowerCase()];
}

/**
 * Gets the YNAB account NAME for a given account ending (last 4 digits).
 * Returns undefined if not mapped.
 *
 * @param ending - The last 4 digits of the account (e.g., "1234")
 * @returns The YNAB account name or undefined
 */
export function getAccountNameByEnding(ending: string): string | undefined {
  return ACCOUNT_ENDING_HINTS[ending];
}
