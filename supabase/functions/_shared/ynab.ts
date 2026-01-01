/**
 * YNAB API CLIENT — Minimal wrapper for YNAB API calls.
 */

const YNAB_BASE_URL = "https://api.youneedabudget.com/v1";

export type YnabClearingStatus = "cleared" | "uncleared" | "reconciled";

export interface YnabTransaction {
  account_id: string;
  date: string;
  amount: number;
  payee_id?: string;
  payee_name?: string;
  memo?: string;
  cleared?: YnabClearingStatus;
  approved?: boolean;
  import_id?: string;
}

export interface YnabClientOptions {
  token: string;
  budgetId?: string;
}

interface YnabCreateAccountInput {
  name: string;
  type:
    | "checking"
    | "savings"
    | "cash"
    | "creditCard"
    | "lineOfCredit"
    | "otherAsset"
    | "otherLiability";
  balance?: number;
}

export function createYnabClient({ token, budgetId }: YnabClientOptions) {
  if (!token) throw new Error("YNAB token missing");

  const ynabFetch = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
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
    listBudgets: () => ynabFetch<{ data: { budgets: any[] } }>("/budgets"),

    listAccounts: (explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<{ data: { accounts: any[] } }>(
        `/budgets/${id}/accounts`,
      );
    },

    listCategories: (explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<{ data: { category_groups: any[] } }>(
        `/budgets/${id}/categories`,
      );
    },

    listPayees: (explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<{ data: { payees: any[] } }>(`/budgets/${id}/payees`);
    },

    createTransaction: (tx: YnabTransaction, explicitBudgetId?: string) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<
        { data: { transaction_ids: string[]; duplicate_import_ids: string[] } }
      >(
        `/budgets/${id}/transactions`,
        { method: "POST", body: JSON.stringify({ transactions: [tx] }) },
      );
    },

    createAccount: (
      account: YnabCreateAccountInput,
      explicitBudgetId?: string,
    ) => {
      const id = explicitBudgetId ?? budgetId;
      if (!id) throw new Error("budgetId required");
      return ynabFetch<{ data: { account: any } }>(`/budgets/${id}/accounts`, {
        method: "POST",
        body: JSON.stringify({
          account: { ...account, balance: account.balance ?? 0 },
        }),
      });
    },
  };
}
