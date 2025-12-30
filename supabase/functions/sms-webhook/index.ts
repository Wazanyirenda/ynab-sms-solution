/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SMS WEBHOOK — Supabase Edge Function
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Receives SMS data from iOS Shortcuts and creates transactions in YNAB.
 *
 * Endpoint: POST /functions/v1/sms-webhook
 *
 * Flow:
 * 1. Validate webhook secret (if configured)
 * 2. Parse the incoming SMS payload
 * 3. Fetch YNAB accounts/categories (cached for performance)
 * 4. Extract transaction data (amount, direction, account, category)
 * 5. Create the transaction in YNAB
 *
 * Configuration: supabase/functions/_shared/config.ts
 * (Uses account/category NAMES — no more hardcoded UUIDs!)
 */

// Edge runtime types so Deno understands the Supabase environment.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Shared modules.
import { createYnabClient } from "../_shared/ynab.ts";
import { ensureCache } from "../_shared/ynab-lookup.ts";
import {
  makeImportId,
  normalizeDate,
  parseSmsContext,
} from "../_shared/parsers.ts";
import { resolveAccountId } from "../_shared/routing.ts";

// ═══════════════════════════════════════════════════════════════════════════
// ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════════════
// These are loaded from Supabase secrets (production) or .env.local (local dev).
// NEVER hardcode secrets in source code!

const ynabToken = Deno.env.get("YNAB_TOKEN");
const ynabBudgetId = Deno.env.get("YNAB_BUDGET_ID");
const webhookSecret = Deno.env.get("WEBHOOK_SECRET");

// YNAB integration is only enabled if both token and budget ID are set.
const ynabEnabled = Boolean(ynabToken && ynabBudgetId);

// ═══════════════════════════════════════════════════════════════════════════
// PAYLOAD TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface IncomingPayload {
  source?: string; // Where the SMS came from (e.g., "ios_shortcuts_sms")
  text?: any; // The SMS body (may be string or object)
  received_at?: string; // Legacy field name
  receivedAt?: string; // Preferred: timestamp when phone received the SMS
  sender?: string; // SMS sender name (e.g., "AirtelMoney", "Absa")
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN REQUEST HANDLER
// ═══════════════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: Validate webhook secret (if configured).
  // This prevents unauthorized callers from hitting the endpoint.
  // ─────────────────────────────────────────────────────────────────────────
  if (webhookSecret) {
    const providedSecret = req.headers.get("x-webhook-secret");
    if (providedSecret !== webhookSecret) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: Parse the incoming JSON payload.
  // ─────────────────────────────────────────────────────────────────────────
  let payload: IncomingPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: Normalize payload fields.
  // ─────────────────────────────────────────────────────────────────────────
  const source = payload.source ?? "unknown";
  const rawText = payload.text ?? "";
  const text = typeof rawText === "string" ? rawText : JSON.stringify(rawText);
  const receivedAtRaw = payload.receivedAt ?? payload.received_at;
  const receivedAtIso = normalizeDate(receivedAtRaw);
  const sender = payload.sender ?? "unknown";

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: Process with YNAB (if enabled).
  // ─────────────────────────────────────────────────────────────────────────
  const ynabResult = ynabEnabled
    ? await processWithYnab({ text, sender, receivedAtIso })
    : { sent: false, reason: "YNAB not configured" };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5: Log and return response.
  // ─────────────────────────────────────────────────────────────────────────
  console.log("SMS WEBHOOK:", {
    source,
    sender,
    receivedAt: receivedAtRaw ?? receivedAtIso,
    text,
    ynabResult,
  });

  return json({
    ok: true,
    source,
    sender,
    received_at: receivedAtIso,
    preview: text.slice(0, 160),
    ynab: ynabResult,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// YNAB PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

interface YnabResult {
  sent: boolean;
  reason?: string;
  detail?: string;
  account?: string;
  category?: string;
  transaction_ids?: string[];
  duplicate_import_ids?: string[];
}

/**
 * Processes an SMS and creates a transaction in YNAB.
 *
 * @param params - SMS context (text, sender, timestamp)
 * @returns Result indicating success or failure with reason
 */
async function processWithYnab(params: {
  text: string;
  sender: string;
  receivedAtIso: string;
}): Promise<YnabResult> {
  const { text, sender, receivedAtIso } = params;

  // Double-check env vars (should already be true if we got here).
  if (!ynabToken || !ynabBudgetId) {
    return { sent: false, reason: "YNAB env missing" };
  }

  // Create YNAB client.
  const client = createYnabClient({ token: ynabToken, budgetId: ynabBudgetId });

  // Ensure we have fresh account/category data from YNAB.
  // This is cached, so subsequent requests in the same instance are fast.
  try {
    await ensureCache(client, ynabBudgetId);
  } catch (err) {
    console.error("Failed to fetch YNAB data:", err);
    return {
      sent: false,
      reason: "Failed to fetch YNAB accounts/categories",
      detail: String(err),
    };
  }

  // Parse the SMS to extract transaction data.
  const smsContext = parseSmsContext(text);

  // Skip balance-only notifications.
  if (smsContext.isBalanceOnly) {
    return { sent: false, reason: "Balance-only message" };
  }

  // Skip spam/ad messages (betting promos, ads with currency amounts, etc.).
  if (smsContext.isSpam) {
    return { sent: false, reason: "Spam/ad message filtered" };
  }

  // Skip if we couldn't parse amount/direction.
  if (!smsContext.parsed) {
    return { sent: false, reason: "Could not parse amount/direction" };
  }

  // Generate a deterministic import ID for deduplication.
  const importId = await makeImportId({
    sender,
    date: receivedAtIso.slice(0, 10),
    amountMilli: smsContext.parsed.amountMilli,
    text,
  });

  // Resolve the YNAB account to use.
  const routing = await resolveAccountId(text, sender, client, ynabBudgetId);

  if (!routing.accountId) {
    return { sent: false, reason: "No account resolved or creatable" };
  }

  // Build the transaction object.
  const transaction = {
    account_id: routing.accountId,
    date: receivedAtIso.slice(0, 10),
    amount: smsContext.parsed.amountMilli * smsContext.parsed.sign,
    payee_name: smsContext.payeeName, // Only set for airtime; undefined otherwise
    memo: text, // Keep full SMS for context
    cleared: "cleared" as const,
    approved: false, // Keep manual approval for safety
    import_id: importId,
    ...(smsContext.categoryId ? { category_id: smsContext.categoryId } : {}),
  };

  // Send to YNAB.
  try {
    const res = await client.createTransaction(transaction);
    return {
      sent: true,
      account: routing.accountName,
      category: smsContext.categoryName,
      transaction_ids: res.data.transaction_ids,
      duplicate_import_ids: res.data.duplicate_import_ids,
    };
  } catch (err) {
    console.error("YNAB error:", err);
    return { sent: false, reason: "YNAB error", detail: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a JSON response with proper headers.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
