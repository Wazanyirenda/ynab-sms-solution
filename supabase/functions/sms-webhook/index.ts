/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SMS WEBHOOK — Supabase Edge Function
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Receives SMS data from iOS Shortcuts and creates transactions in YNAB.
 * Uses Google Gemini AI to intelligently parse SMS messages.
 *
 * Endpoint: POST /functions/v1/sms-webhook
 *
 * Flow:
 * 1. Validate webhook secret (if configured)
 * 2. Parse the incoming SMS payload
 * 3. Send SMS to Gemini AI for intelligent parsing
 * 4. Route to correct YNAB account based on sender
 * 5. Create the transaction in YNAB
 *
 * Configuration: supabase/functions/_shared/config.ts
 */

// Edge runtime types so Deno understands the Supabase environment.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Shared modules.
import { createYnabClient } from "../_shared/ynab.ts";
import { ensureCache, getCategoryIdByName } from "../_shared/ynab-lookup.ts";
import { makeImportId, normalizeDate } from "../_shared/parsers.ts";
import { resolveAccountId } from "../_shared/routing.ts";
import {
  GeminiParsedSms,
  getSign,
  parseWithGemini,
  toMilliunits,
} from "../_shared/gemini.ts";

// ═══════════════════════════════════════════════════════════════════════════
// ENVIRONMENT VARIABLES
// ═══════════════════════════════════════════════════════════════════════════
// These are loaded from Supabase secrets (production) or .env.local (local dev).
// NEVER hardcode secrets in source code!

const ynabToken = Deno.env.get("YNAB_TOKEN");
const ynabBudgetId = Deno.env.get("YNAB_BUDGET_ID");
const webhookSecret = Deno.env.get("WEBHOOK_SECRET");
const geminiApiKey = Deno.env.get("GEMINI_API_KEY");

// YNAB integration is only enabled if both token and budget ID are set.
const ynabEnabled = Boolean(ynabToken && ynabBudgetId);

// Gemini AI is required for SMS parsing.
const geminiEnabled = Boolean(geminiApiKey);

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
  // Include AI output in logs for debugging!
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
  payee?: string;
  memo?: string;
  amount?: number;
  direction?: string;
  transaction_ids?: string[];
  duplicate_import_ids?: string[];
  // AI parsing output for debugging
  ai_parsed?: GeminiParsedSms;
  ai_raw?: string;
}

/**
 * Processes an SMS and creates a transaction in YNAB.
 * Uses Gemini AI for intelligent SMS parsing.
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

  // ─────────────────────────────────────────────────────────────────────────
  // Check required environment variables.
  // ─────────────────────────────────────────────────────────────────────────
  if (!ynabToken || !ynabBudgetId) {
    return { sent: false, reason: "YNAB env missing" };
  }

  if (!geminiEnabled || !geminiApiKey) {
    return { sent: false, reason: "GEMINI_API_KEY not configured" };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Call Gemini AI to parse the SMS.
  // ─────────────────────────────────────────────────────────────────────────
  const geminiResult = await parseWithGemini(text, geminiApiKey);

  // If Gemini failed, log the error and skip this message.
  if (!geminiResult.success || !geminiResult.parsed) {
    console.error("Gemini parsing failed:", geminiResult.error);
    return {
      sent: false,
      reason: "AI parsing failed",
      detail: geminiResult.error,
      ai_raw: geminiResult.raw_response,
    };
  }

  const aiParsed = geminiResult.parsed;

  // Log the AI output for debugging.
  console.log("AI PARSED:", aiParsed);

  // ─────────────────────────────────────────────────────────────────────────
  // Check if this is actually a transaction.
  // The AI decides based on context, not just regex patterns!
  // ─────────────────────────────────────────────────────────────────────────
  if (!aiParsed.is_transaction) {
    return {
      sent: false,
      reason: "Not a transaction",
      detail: aiParsed.reason,
      ai_parsed: aiParsed,
      ai_raw: geminiResult.raw_response,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Validate we have the required transaction data.
  // ─────────────────────────────────────────────────────────────────────────
  if (aiParsed.amount === null || aiParsed.amount === undefined) {
    return {
      sent: false,
      reason: "AI could not extract amount",
      ai_parsed: aiParsed,
      ai_raw: geminiResult.raw_response,
    };
  }

  if (!aiParsed.direction) {
    return {
      sent: false,
      reason: "AI could not determine direction",
      ai_parsed: aiParsed,
      ai_raw: geminiResult.raw_response,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialize YNAB client and cache.
  // ─────────────────────────────────────────────────────────────────────────
  const client = createYnabClient({ token: ynabToken, budgetId: ynabBudgetId });

  try {
    await ensureCache(client, ynabBudgetId);
  } catch (err) {
    console.error("Failed to fetch YNAB data:", err);
    return {
      sent: false,
      reason: "Failed to fetch YNAB accounts/categories",
      detail: String(err),
      ai_parsed: aiParsed,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Resolve the YNAB account based on sender/message content.
  // This still uses our deterministic routing logic.
  // ─────────────────────────────────────────────────────────────────────────
  const routing = await resolveAccountId(text, sender, client, ynabBudgetId);

  if (!routing.accountId) {
    return {
      sent: false,
      reason: "No account resolved or creatable",
      ai_parsed: aiParsed,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Look up category ID if AI suggested a category.
  // ─────────────────────────────────────────────────────────────────────────
  let categoryId: string | undefined;
  if (aiParsed.category_hint) {
    categoryId = getCategoryIdByName(aiParsed.category_hint);
    // If the exact name doesn't match, try some common mappings
    if (!categoryId) {
      // Try with emoji prefix for common categories
      const categoryMappings: Record<string, string> = {
        "Airtime": "🛜 Data / Airtime",
        "Data": "🛜 Data / Airtime",
        "Transfer": "Transfer",
        "Groceries": "🛒 Groceries",
        "Utilities": "🏠 Utilities",
        "Cash Withdrawal": "💵 Cash",
      };
      const mappedName = categoryMappings[aiParsed.category_hint];
      if (mappedName) {
        categoryId = getCategoryIdByName(mappedName);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generate import ID for deduplication.
  // ─────────────────────────────────────────────────────────────────────────
  const amountMilli = toMilliunits(aiParsed.amount);
  const importId = await makeImportId({
    sender,
    date: receivedAtIso.slice(0, 10),
    amountMilli,
    text,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Build the YNAB transaction.
  // ─────────────────────────────────────────────────────────────────────────
  const sign = getSign(aiParsed.direction);
  
  // Use AI-generated memo if available, otherwise fall back to raw SMS
  // AI memo is cleaner (e.g., "Received from Harry Banda via Zamtel")
  const memo = aiParsed.memo ?? text.slice(0, 200);
  
  const transaction = {
    account_id: routing.accountId,
    date: receivedAtIso.slice(0, 10),
    amount: amountMilli * sign,
    payee_name: aiParsed.payee ?? undefined, // AI-extracted payee
    memo, // Clean AI-generated memo
    cleared: "cleared" as const,
    approved: false, // Keep manual approval for safety
    import_id: importId,
    ...(categoryId ? { category_id: categoryId } : {}),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Send to YNAB.
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const res = await client.createTransaction(transaction);
    return {
      sent: true,
      account: routing.accountName,
      category: aiParsed.category_hint ?? undefined,
      payee: aiParsed.payee ?? undefined,
      memo, // AI-generated clean memo
      amount: aiParsed.amount,
      direction: aiParsed.direction,
      transaction_ids: res.data.transaction_ids,
      duplicate_import_ids: res.data.duplicate_import_ids,
      ai_parsed: aiParsed,
      ai_raw: geminiResult.raw_response,
    };
  } catch (err) {
    console.error("YNAB error:", err);
    return {
      sent: false,
      reason: "YNAB error",
      detail: String(err),
      ai_parsed: aiParsed,
    };
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
