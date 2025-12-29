/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ACCOUNT ROUTING — Determines which YNAB account to use for a transaction.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Routing priority:
 * 1. Account ending hints (e.g., "ending 1234" → account name → ID)
 * 2. Sender mapping (e.g., "AirtelMoney" → "Airtel Money" → ID)
 * 3. Fallback: create/find "Unknown Imports" account
 *
 * This module uses NAME-based lookups. Account IDs are resolved at runtime
 * from the YNAB API cache, so you never need to hardcode UUIDs.
 */

import {
  getAccountNameBySender,
  getAccountNameByEnding,
  FALLBACK_ACCOUNT_NAME,
} from "./config.ts";
import { getAccountIdByName, findAccountByName } from "./ynab-lookup.ts";
import { createYnabClient } from "./ynab.ts";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface RoutingResult {
  accountId: string | undefined;
  accountName: string | undefined;
  source: "ending_hint" | "sender_mapping" | "fallback_created" | "fallback_existing" | "failed";
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNT ENDING EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extracts the account ending hint from SMS text (e.g., "ending 1234").
 * Returns the last 4 digits or undefined if not found.
 */
export function extractAccountEnding(text: string): string | undefined {
  const match = text.match(/ending\s+(\d{4})/i);
  return match?.[1];
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ROUTING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolves the YNAB account ID for a transaction.
 *
 * Priority:
 * 1. If SMS contains "ending XXXX" and we have a mapping, use that account.
 * 2. Otherwise, map the sender to an account name, then look up the ID.
 * 3. If all else fails, find or create a fallback "Unknown Imports" account.
 *
 * @param text - SMS text (to check for ending hints)
 * @param sender - SMS sender name
 * @param client - YNAB API client (for creating fallback account)
 * @param budgetId - YNAB budget ID
 * @returns RoutingResult with account ID, name, and source
 */
export async function resolveAccountId(
  text: string,
  sender: string | undefined,
  client: ReturnType<typeof createYnabClient>,
  budgetId: string,
): Promise<RoutingResult> {
  // Priority 1: Check for account ending hint in SMS.
  const ending = extractAccountEnding(text);
  if (ending) {
    const accountName = getAccountNameByEnding(ending);
    if (accountName) {
      const accountId = getAccountIdByName(accountName);
      if (accountId) {
        return { accountId, accountName, source: "ending_hint" };
      }
      // Name mapped but account not found in YNAB — fall through to sender mapping
      console.warn(`Account ending ${ending} mapped to "${accountName}" but not found in YNAB`);
    }
  }

  // Priority 2: Map sender to account name, then look up ID.
  if (sender) {
    const accountName = getAccountNameBySender(sender);
    if (accountName) {
      const accountId = getAccountIdByName(accountName);
      if (accountId) {
        return { accountId, accountName, source: "sender_mapping" };
      }
      // Name mapped but account not found in YNAB — fall through to fallback
      console.warn(`Sender "${sender}" mapped to "${accountName}" but not found in YNAB`);
    }
  }

  // Priority 3: Use or create fallback account.
  const fallbackResult = await ensureFallbackAccount(client, budgetId);
  return fallbackResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// FALLBACK ACCOUNT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ensures a fallback account exists in YNAB for unmatched senders.
 * Checks the cache first, then creates if needed.
 *
 * @param client - YNAB API client
 * @param budgetId - YNAB budget ID
 * @returns RoutingResult with the fallback account
 */
async function ensureFallbackAccount(
  client: ReturnType<typeof createYnabClient>,
  budgetId: string,
): Promise<RoutingResult> {
  // Check if fallback account already exists in cache.
  const existing = findAccountByName(FALLBACK_ACCOUNT_NAME);
  if (existing) {
    return {
      accountId: existing.id,
      accountName: FALLBACK_ACCOUNT_NAME,
      source: "fallback_existing",
    };
  }

  // Create the fallback account.
  try {
    console.log(`Creating fallback account: "${FALLBACK_ACCOUNT_NAME}"`);
    const created = await client.createAccount(
      { name: FALLBACK_ACCOUNT_NAME, type: "checking", balance: 0 },
      budgetId,
    );
    return {
      accountId: created.data.account.id,
      accountName: FALLBACK_ACCOUNT_NAME,
      source: "fallback_created",
    };
  } catch (err) {
    console.error("Failed to create fallback account:", err);
    return {
      accountId: undefined,
      accountName: undefined,
      source: "failed",
    };
  }
}
