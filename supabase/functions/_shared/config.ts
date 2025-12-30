/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFIGURATION FILE — Map SMS senders to YNAB account/category NAMES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NO MORE UUIDs! Just use the human-readable names from your YNAB budget.
 * The system will automatically look up the IDs at runtime.
 *
 * HOW TO CONFIGURE:
 * 1. Look at your YNAB account names (e.g., "Airtel Money", "ABSA Current")
 * 2. Map SMS senders to those account names below
 * 3. Look at your YNAB category names (e.g., "Airtime", "Groceries")
 * 4. Add category rules that map keywords to category names
 *
 * That's it! No need to hunt for UUIDs.
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
  // Mobile Money
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
// ACCOUNT ENDING HINTS
// ═══════════════════════════════════════════════════════════════════════════
// Some bank SMS includes "account ending XXXX". This overrides sender mapping.
// Maps the last 4 digits to your YNAB account NAME.

export const ACCOUNT_ENDING_HINTS: Record<string, string> = {
  // Example: "ending 1234" → routes to "My Savings Account"
  // "1234": "My Savings Account",
  // "5678": "My Current Account",
};

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY RULES
// ═══════════════════════════════════════════════════════════════════════════
// Regex patterns to auto-assign categories. First match wins.
// Use your exact YNAB category NAMES (case-insensitive matching).

export const CATEGORY_RULES: Array<{ pattern: RegExp; categoryName: string }> =
  [
    // Airtime/top-up and data purchases
    {
      pattern: /\bairtime|top[- ]?up|data\b/i,
      categoryName: "🛜 Data / Airtime",
    },
    // Add more rules using your YNAB category names:
    // { pattern: /\bfuel|petrol|diesel\b/i, categoryName: "Fuel" },
    // { pattern: /\bshoprite|pick ?n ?pay|spar\b/i, categoryName: "Groceries" },
    // { pattern: /\bzesco|water|utility\b/i, categoryName: "Utilities" },
  ];

// ═══════════════════════════════════════════════════════════════════════════
// PAYEE RULES (for airtime/top-up only)
// ═══════════════════════════════════════════════════════════════════════════
// When we detect an airtime purchase, set payee based on network mentioned in SMS.

export const PAYEE_BY_NETWORK: Array<{ pattern: RegExp; payee: string }> = [
  { pattern: /\bairtel\b/i, payee: "Airtel" },
  { pattern: /\bmtn|momo\b/i, payee: "MTN" },
  { pattern: /\bzamtel\b/i, payee: "Zamtel" },
];

// ═══════════════════════════════════════════════════════════════════════════
// PARSING KEYWORDS
// ═══════════════════════════════════════════════════════════════════════════
// Keywords used to determine if a transaction is income (inflow) or expense (outflow).
// Add more keywords if your bank uses different terminology.

export const INCOME_KEYWORDS = [
  "received",
  "credited",
  "deposit",
  "incoming",
  "reversal",
  "refund",
];

export const OUTFLOW_KEYWORDS = [
  "sent to",
  "paid",
  "purchase",
  "debited",
  "withdraw",
  "cash out",
  "transfer to",
];

// ═══════════════════════════════════════════════════════════════════════════
// BALANCE-ONLY DETECTION
// ═══════════════════════════════════════════════════════════════════════════
// Phrases that indicate a balance-only notification (not a transaction).
// These messages will be ignored and not sent to YNAB.

export const BALANCE_ONLY_PHRASES = [
  "balance on your account ending",
  "your available balance is",
  "the balance on your account",
  "available balance is now",
];

// ═══════════════════════════════════════════════════════════════════════════
// SPAM / AD DETECTION
// ═══════════════════════════════════════════════════════════════════════════
// Phrases and patterns that indicate promotional/ad SMS messages.
// Messages are ONLY flagged as spam if they have spam indicators AND
// do NOT contain real transaction verbs (sent, received, credited, etc.).
// This prevents false positives on real transaction messages.

export const SPAM_KEYWORDS = [
  // Betting/gambling promotions (very specific)
  "welcome bonus",
  "win big",
  "free spins",
  "jackpot",
  "betting",
  "casino",
  "moors zambia",
  "betpawa",
  "sportybet",
  // Marketing language (only strong indicators)
  "sign up now",
  "register now",
  "join today",
  "click here",
  "tap here",
  "don't miss out",
  "act now",
];

// URL patterns often indicate ads/promos (promotional links)
export const SPAM_URL_PATTERN =
  /https?:\/\/|\.com\/|\.co\.zm\/|\.zm\/|-->.*\.zm/i;

// Verbs that indicate an actual transaction (if present, it's NOT balance-only).
export const TRANSACTION_VERBS =
  /sent|received|credited|debited|withdraw|purchase|top[- ]?up|airtime|pos|cash out/i;

// ═══════════════════════════════════════════════════════════════════════════
// FALLBACK ACCOUNT NAME
// ═══════════════════════════════════════════════════════════════════════════
// If we can't match a sender, we'll create/use this account as a catch-all inbox.

export const FALLBACK_ACCOUNT_NAME = "Unknown Imports";

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gets the YNAB account NAME for a given SMS sender.
 * Returns undefined if sender is not mapped.
 */
export function getAccountNameBySender(sender: string): string | undefined {
  return SENDER_TO_ACCOUNT[sender.toLowerCase()];
}

/**
 * Gets the YNAB account NAME for a given account ending (last 4 digits).
 * Returns undefined if not mapped.
 */
export function getAccountNameByEnding(ending: string): string | undefined {
  return ACCOUNT_ENDING_HINTS[ending];
}

/**
 * Finds a matching category NAME for the given SMS text.
 * Returns the category name or undefined.
 */
export function matchCategoryName(text: string): string | undefined {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) {
      return rule.categoryName;
    }
  }
  return undefined;
}

/**
 * Finds a matching payee for airtime/top-up messages.
 * Returns the payee name or undefined.
 */
export function matchPayee(text: string): string | undefined {
  const isAirtime = /\bairtime|top[- ]?up\b/i.test(text);
  if (!isAirtime) return undefined;

  for (const rule of PAYEE_BY_NETWORK) {
    if (rule.pattern.test(text)) {
      return rule.payee;
    }
  }
  return undefined;
}

/**
 * Checks if the SMS is a balance-only notification (not a transaction).
 */
export function isBalanceOnlyMessage(text: string): boolean {
  const lower = text.toLowerCase();
  const hasBalancePhrase = BALANCE_ONLY_PHRASES.some((phrase) =>
    lower.includes(phrase) || lower.startsWith(phrase)
  );
  const hasTxnVerb = TRANSACTION_VERBS.test(text);
  return hasBalancePhrase && !hasTxnVerb;
}

/**
 * Checks if the SMS is a spam/advertisement message (not a real transaction).
 * These often contain currency amounts as part of promotional offers.
 *
 * IMPORTANT: A message is ONLY considered spam if it has spam indicators
 * AND does NOT contain real transaction verbs. This prevents filtering out
 * real transactions that happen to contain words like "deposit" or "bonus".
 *
 * Example that WILL be filtered (spam):
 *   "WIN ZMW 5,000! Join today --> betting.co.zm"
 *
 * Example that will NOT be filtered (real transaction):
 *   "Your first deposit of ZMW 500 was credited to your account"
 */
export function isSpamMessage(text: string): boolean {
  const lower = text.toLowerCase();

  // First check: does this look like a real transaction?
  // If it has transaction verbs, it's NOT spam (even if it has spam keywords)
  const hasTransactionVerb = TRANSACTION_VERBS.test(text);
  if (hasTransactionVerb) {
    return false; // Real transaction, not spam
  }

  // Second check: does it have spam indicators?
  const hasSpamKeyword = SPAM_KEYWORDS.some((keyword) =>
    lower.includes(keyword)
  );
  const hasPromoUrl = SPAM_URL_PATTERN.test(text);

  // Only spam if it has spam indicators AND no transaction verbs
  return hasSpamKeyword || hasPromoUrl;
}
