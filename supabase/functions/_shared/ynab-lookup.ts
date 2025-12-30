/**
 * ═══════════════════════════════════════════════════════════════════════════
 * YNAB LOOKUP — Resolves account/category/payee NAMES to IDs at runtime.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS:
 * - YNAB IDs (UUIDs) change when you delete/recreate accounts or categories.
 * - Instead of hardcoding IDs, we use human-readable NAMES in config.
 * - This module fetches the current IDs from YNAB API and caches them.
 *
 * HOW IT WORKS:
 * 1. First request fetches accounts, categories, and payees from YNAB API.
 * 2. Results are cached in memory for the lifetime of the Edge Function instance.
 * 3. Lookups by name return the corresponding ID.
 * 4. Category/payee names are passed to AI for intelligent matching.
 *
 * TRADE-OFF:
 * - Slightly slower first request (extra API calls).
 * - But no manual ID management — names are stable and human-readable.
 */

import { createYnabClient } from "./ynab.ts";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface YnabAccount {
  id: string;
  name: string;
  type: string;
  deleted: boolean;
  transfer_payee_id: string;
}

interface YnabCategory {
  id: string;
  name: string;
  deleted: boolean;
  category_group_id: string;
}

interface YnabPayee {
  id: string;
  name: string;
  deleted: boolean;
  transfer_account_id: string | null; // Non-null if this is a transfer payee
}

interface CachedData {
  accounts: YnabAccount[];
  categories: YnabCategory[];
  payees: YnabPayee[];
  fetchedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════════════════

// In-memory cache. Persists for the lifetime of the Edge Function instance.
// On cold starts, this will be empty and we'll fetch fresh data.
let cache: CachedData | null = null;

// Cache TTL in milliseconds (5 minutes). After this, we'll refresh on next request.
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Checks if the cache is still valid.
 */
function isCacheValid(): boolean {
  if (!cache) return false;
  const age = Date.now() - cache.fetchedAt;
  return age < CACHE_TTL_MS;
}

/**
 * Clears the cache. Useful if you need to force a refresh.
 */
export function clearCache(): void {
  cache = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FETCH AND CACHE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ensures the cache is populated with fresh data from YNAB.
 * If the cache is valid, this is a no-op.
 *
 * @param client - YNAB API client
 * @param budgetId - YNAB budget ID
 */
export async function ensureCache(
  client: ReturnType<typeof createYnabClient>,
  budgetId: string,
): Promise<void> {
  if (isCacheValid()) return;

  console.log("YNAB Lookup: Fetching accounts, categories, and payees...");

  // Fetch accounts, categories, and payees in parallel for speed.
  const [accountsRes, categoriesRes, payeesRes] = await Promise.all([
    client.listAccounts(budgetId),
    client.listCategories(budgetId),
    client.listPayees(budgetId),
  ]);

  // Flatten category groups into a single list of categories.
  const categories: YnabCategory[] = [];
  for (const group of categoriesRes.data.category_groups) {
    if (group.categories) {
      categories.push(...group.categories);
    }
  }

  cache = {
    accounts: accountsRes.data.accounts,
    categories,
    payees: payeesRes.data.payees,
    fetchedAt: Date.now(),
  };

  console.log(
    `YNAB Lookup: Cached ${cache.accounts.length} accounts, ${cache.categories.length} categories, ${cache.payees.length} payees`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOOKUP FUNCTIONS — ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Finds a YNAB account by name.
 * Returns the account object or undefined if not found.
 *
 * @param name - Account name (case-insensitive)
 */
export function findAccountByName(name: string): YnabAccount | undefined {
  if (!cache) return undefined;
  const lower = name.toLowerCase();
  return cache.accounts.find(
    (a) => a.name.toLowerCase() === lower && !a.deleted,
  );
}

/**
 * Gets a YNAB account ID by name.
 * Returns the ID or undefined if not found.
 *
 * @param name - Account name (case-insensitive)
 */
export function getAccountIdByName(name: string): string | undefined {
  return findAccountByName(name)?.id;
}

/**
 * Gets all cached accounts (for debugging or listing).
 */
export function getAllAccounts(): YnabAccount[] {
  return cache?.accounts.filter((a) => !a.deleted) ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════
// LOOKUP FUNCTIONS — CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Finds a YNAB category by name.
 * Returns the category object or undefined if not found.
 *
 * @param name - Category name (case-insensitive)
 */
export function findCategoryByName(name: string): YnabCategory | undefined {
  if (!cache) return undefined;
  const lower = name.toLowerCase();
  return cache.categories.find(
    (c) => c.name.toLowerCase() === lower && !c.deleted,
  );
}

/**
 * Gets a YNAB category ID by name.
 * Returns the ID or undefined if not found.
 *
 * @param name - Category name (case-insensitive)
 */
export function getCategoryIdByName(name: string): string | undefined {
  return findCategoryByName(name)?.id;
}

/**
 * Gets all cached categories (for debugging or listing).
 */
export function getAllCategories(): YnabCategory[] {
  return cache?.categories.filter((c) => !c.deleted) ?? [];
}

/**
 * Gets all category names (for AI prompt).
 * Excludes internal/hidden categories.
 */
export function getAllCategoryNames(): string[] {
  if (!cache) return [];
  return cache.categories
    .filter((c) => !c.deleted && !c.name.startsWith("Internal:"))
    .map((c) => c.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOOKUP FUNCTIONS — PAYEES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Finds a YNAB payee by name.
 * Returns the payee object or undefined if not found.
 *
 * @param name - Payee name (case-insensitive)
 */
export function findPayeeByName(name: string): YnabPayee | undefined {
  if (!cache) return undefined;
  const lower = name.toLowerCase();
  return cache.payees.find(
    (p) => p.name.toLowerCase() === lower && !p.deleted,
  );
}

/**
 * Gets a YNAB payee ID by name.
 * Returns the ID or undefined if not found.
 *
 * @param name - Payee name (case-insensitive)
 */
export function getPayeeIdByName(name: string): string | undefined {
  return findPayeeByName(name)?.id;
}

/**
 * Gets all cached payees (for debugging or listing).
 */
export function getAllPayees(): YnabPayee[] {
  return cache?.payees.filter((p) => !p.deleted) ?? [];
}

/**
 * Gets all payee names (for AI prompt).
 * Excludes transfer payees (those linked to accounts).
 */
export function getAllPayeeNames(): string[] {
  if (!cache) return [];
  return cache.payees
    .filter((p) => !p.deleted && !p.transfer_account_id) // Exclude transfer payees
    .map((p) => p.name);
}
