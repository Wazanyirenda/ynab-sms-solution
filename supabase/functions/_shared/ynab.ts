// Base URL for all YNAB API calls; keep it centralized so we don't duplicate strings.
const YNAB_BASE_URL = "https://api.youneedabudget.com/v1";

// YNAB only accepts these clearing states.
export type YnabClearingStatus = "cleared" | "uncleared" | "reconciled";

// Minimal transaction shape we need to send to YNAB.
export interface YnabTransaction {
  account_id: string;
  date: string; // ISO yyyy-mm-dd
  amount: number; // milliunits (e.g., ZMW 12.34 => 12340)
  payee_id?: string;
  payee_name?: string;
  memo?: string;
  cleared?: YnabClearingStatus;
  approved?: boolean;
  import_id?: string; // use a deterministic value for dedupe
}

export interface YnabClientOptions {
  token: string;
  budgetId?: string;
}

interface YnabListBudgetsResponse {
  data: { budgets: any[] };
}

interface YnabListAccountsResponse {
  data: { accounts: any[] };
}

interface YnabCreateTransactionsResponse {
  data: { transaction_ids: string[]; duplicate_import_ids: string[] };
}

interface YnabCreateAccountResponse {
  data: { account: any };
}

interface YnabListCategoriesResponse {
  data: { category_groups: any[] };
}

interface YnabCreateAccountInput {
  name: string;
  type: "checking" | "savings" | "cash" | "creditCard" | "lineOfCredit" | "otherAsset" | "otherLiability";
  balance?: number; // milliunits; defaults to 0
}

export function createYnabClient({ token, budgetId }: YnabClientOptions) {
  // Fail fast if the token is missing so we avoid confusing network errors later.
  if (!token) {
    throw new Error("YNAB token missing");
  }

  // Tiny helper that attaches auth headers and surfaces API errors with text body.
  const ynabFetch = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${YNAB_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`YNAB ${res.status} ${res.statusText}: ${body}`);
    }

    return (await res.json()) as T;
  };

  return {
    // Lists all budgets for the user (useful to grab budget IDs).
    listBudgets: () => ynabFetch<YnabListBudgetsResponse>("/budgets"),

    // Lists accounts for a specific budget (needed to map SMS senders to accounts).
    listAccounts: (explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<YnabListAccountsResponse>(`/budgets/${id}/accounts`);
    },

    // Lists categories for a specific budget (needed to auto-assign categories).
    listCategories: (explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<YnabListCategoriesResponse>(`/budgets/${id}/categories`);
    },

    // Creates one transaction; we wrap it in an array because YNAB expects a list.
    createTransaction: (tx: YnabTransaction, explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<YnabCreateTransactionsResponse>(`/budgets/${id}/transactions`, {
        method: "POST",
        body: JSON.stringify({ transactions: [tx] }),
      });
    },

    // Creates an account (e.g., "Unknown Imports") so we have a safe fallback inbox.
    createAccount: (account: YnabCreateAccountInput, explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      const payload = { account: { ...account, balance: account.balance ?? 0 } };
      return ynabFetch<YnabCreateAccountResponse>(`/budgets/${id}/accounts`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
  };
}