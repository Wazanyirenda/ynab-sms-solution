/**
 * YNAB LOOKUP — Resolves account/category/payee names to IDs at runtime.
 *
 * Instead of hardcoding UUIDs, we use human-readable names in config.
 * This module fetches current IDs from YNAB API and caches them.
 */

import { createYnabClient } from "./ynab.ts";

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
  transfer_account_id: string | null;
}

interface CachedData {
  accounts: YnabAccount[];
  categories: YnabCategory[];
  payees: YnabPayee[];
  fetchedAt: number;
}

let cache: CachedData | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isCacheValid(): boolean {
  if (!cache) return false;
  return Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

export function clearCache(): void {
  cache = null;
}

/**
 * Ensures the cache is populated with fresh data from YNAB.
 */
export async function ensureCache(
  client: ReturnType<typeof createYnabClient>,
  budgetId: string,
): Promise<void> {
  if (isCacheValid()) return;

  const [accountsRes, categoriesRes, payeesRes] = await Promise.all([
    client.listAccounts(budgetId),
    client.listCategories(budgetId),
    client.listPayees(budgetId),
  ]);

  const categories: YnabCategory[] = [];
  for (const group of categoriesRes.data.category_groups) {
    if (group.categories) categories.push(...group.categories);
  }

  cache = {
    accounts: accountsRes.data.accounts,
    categories,
    payees: payeesRes.data.payees,
    fetchedAt: Date.now(),
  };
}

// Account lookups
export function findAccountByName(name: string): YnabAccount | undefined {
  if (!cache) return undefined;
  const lower = name.toLowerCase();
  return cache.accounts.find((a) =>
    a.name.toLowerCase() === lower && !a.deleted
  );
}

export function getAccountIdByName(name: string): string | undefined {
  return findAccountByName(name)?.id;
}

export function getAllAccounts(): YnabAccount[] {
  return cache?.accounts.filter((a) => !a.deleted) ?? [];
}

// Category lookups
export function findCategoryByName(name: string): YnabCategory | undefined {
  if (!cache) return undefined;
  const lower = name.toLowerCase();
  return cache.categories.find((c) =>
    c.name.toLowerCase() === lower && !c.deleted
  );
}

export function getCategoryIdByName(name: string): string | undefined {
  return findCategoryByName(name)?.id;
}

export function getAllCategories(): YnabCategory[] {
  return cache?.categories.filter((c) => !c.deleted) ?? [];
}

export function getAllCategoryNames(): string[] {
  if (!cache) return [];
  return cache.categories
    .filter((c) => !c.deleted && !c.name.startsWith("Internal:"))
    .map((c) => c.name);
}

// Payee lookups
export function findPayeeByName(name: string): YnabPayee | undefined {
  if (!cache) return undefined;
  const lower = name.toLowerCase();
  return cache.payees.find((p) => p.name.toLowerCase() === lower && !p.deleted);
}

export function getPayeeIdByName(name: string): string | undefined {
  return findPayeeByName(name)?.id;
}

export function getAllPayees(): YnabPayee[] {
  return cache?.payees.filter((p) => !p.deleted) ?? [];
}

export function getAllPayeeNames(): string[] {
  if (!cache) return [];
  return cache.payees
    .filter((p) => !p.deleted && !p.transfer_account_id)
    .map((p) => p.name);
}
