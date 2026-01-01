/**
 * ACCOUNT ROUTING — Determines which YNAB account to use for a transaction.
 *
 * Priority:
 * 1. Account ending hints (e.g., "ending 1234")
 * 2. Sender mapping (e.g., "AirtelMoney")
 * 3. Fallback: create/find "Unknown Imports" account
 */

import {
  FALLBACK_ACCOUNT_NAME,
  getAccountNameByEnding,
  getAccountNameBySender,
} from "./config.ts";
import { findAccountByName, getAccountIdByName } from "./ynab-lookup.ts";
import { createYnabClient } from "./ynab.ts";

export interface RoutingResult {
  accountId: string | undefined;
  accountName: string | undefined;
  source:
    | "ending_hint"
    | "sender_mapping"
    | "fallback_created"
    | "fallback_existing"
    | "failed";
}

/**
 * Extracts the account ending from SMS text (e.g., "ending 1234").
 */
export function extractAccountEnding(text: string): string | undefined {
  const match = text.match(/ending\s+(\d{4})/i);
  return match?.[1];
}

/**
 * Resolves the YNAB account ID for a transaction.
 */
export async function resolveAccountId(
  text: string,
  sender: string | undefined,
  client: ReturnType<typeof createYnabClient>,
  budgetId: string,
): Promise<RoutingResult> {
  // Priority 1: Account ending hint
  const ending = extractAccountEnding(text);
  if (ending) {
    const accountName = getAccountNameByEnding(ending);
    if (accountName) {
      const accountId = getAccountIdByName(accountName);
      if (accountId) {
        return { accountId, accountName, source: "ending_hint" };
      }
    }
  }

  // Priority 2: Sender mapping
  if (sender) {
    const accountName = getAccountNameBySender(sender);
    if (accountName) {
      const accountId = getAccountIdByName(accountName);
      if (accountId) {
        return { accountId, accountName, source: "sender_mapping" };
      }
    }
  }

  // Priority 3: Fallback account
  return await ensureFallbackAccount(client, budgetId);
}

async function ensureFallbackAccount(
  client: ReturnType<typeof createYnabClient>,
  budgetId: string,
): Promise<RoutingResult> {
  const existing = findAccountByName(FALLBACK_ACCOUNT_NAME);
  if (existing) {
    return {
      accountId: existing.id,
      accountName: FALLBACK_ACCOUNT_NAME,
      source: "fallback_existing",
    };
  }

  try {
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
    return { accountId: undefined, accountName: undefined, source: "failed" };
  }
}
