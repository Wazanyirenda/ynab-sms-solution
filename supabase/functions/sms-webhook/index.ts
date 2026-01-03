/**
 * SMS WEBHOOK — Supabase Edge Function
 *
 * Receives SMS data from iOS Shortcuts and creates transactions in YNAB.
 * Uses Google Gemini AI to intelligently parse SMS messages.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createYnabClient } from "../_shared/ynab.ts";
import {
  ensureCache,
  getAllCategoryNames,
  getAllPayeeNames,
  getCategoryIdByName,
  getPayeeIdByName,
} from "../_shared/ynab-lookup.ts";
import { makeImportId, normalizeDate } from "../_shared/parsers.ts";
import { resolveAccountId } from "../_shared/routing.ts";
import {
  GeminiParsedSms,
  getSign,
  parseWithGemini,
  toMilliunits,
} from "../_shared/gemini.ts";
import {
  calculateFee,
  getSmsNotificationFee,
  senderToProvider,
  TransferType,
} from "../_shared/fee-calculator.ts";

// Environment variables (set via Supabase secrets)
const ynabToken = Deno.env.get("YNAB_TOKEN");
const ynabBudgetId = Deno.env.get("YNAB_BUDGET_ID");
const webhookSecret = Deno.env.get("WEBHOOK_SECRET");
const geminiApiKey = Deno.env.get("GEMINI_API_KEY");

const ynabEnabled = Boolean(ynabToken && ynabBudgetId);
const geminiEnabled = Boolean(geminiApiKey);

// Payload from iOS Shortcuts
interface IncomingPayload {
  source?: string;
  text?: unknown;
  received_at?: string;
  receivedAt?: string;
  sender?: string;
}

// Result returned to caller and logged
interface YnabResult {
  sent: boolean;
  reason?: string;
  detail?: string;
  account?: string;
  category?: string;
  payee?: string;
  payee_matched?: boolean;
  payee_extracted?: string;
  memo?: string;
  amount?: number;
  direction?: string;
  transaction_ids?: string[];
  duplicate_import_ids?: string[];
  fee?: {
    amount: number;
    payee: string | null;
    transaction_id?: string;
    transfer_type?: string;
  };
  sms_fee?: {
    amount: number;
    payee: string | null;
    transaction_id?: string;
  };
  ai_parsed?: GeminiParsedSms;
  ai_raw?: string;
}

// Main request handler
Deno.serve(async (req) => {
  // Validate webhook secret
  if (webhookSecret) {
    const providedSecret = req.headers.get("x-webhook-secret");
    if (providedSecret !== webhookSecret) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
  }

  // Parse payload
  let payload: IncomingPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  // Normalize fields
  const source = payload.source ?? "unknown";
  const rawText = payload.text ?? "";
  const text = typeof rawText === "string" ? rawText : JSON.stringify(rawText);
  const receivedAtRaw = payload.receivedAt ?? payload.received_at;
  const receivedAtIso = normalizeDate(receivedAtRaw);
  const sender = payload.sender ?? "unknown";

  // Process with YNAB
  const ynabResult = ynabEnabled
    ? await processWithYnab({ text, sender, receivedAtIso })
    : { sent: false, reason: "YNAB not configured" };

  // Log result
  console.log("SMS WEBHOOK:", {
    source,
    sender,
    text: text.slice(0, 100),
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

/**
 * Processes an SMS and creates a transaction in YNAB.
 */
async function processWithYnab(params: {
  text: string;
  sender: string;
  receivedAtIso: string;
}): Promise<YnabResult> {
  const { text, sender, receivedAtIso } = params;

  if (!ynabToken || !ynabBudgetId) {
    return { sent: false, reason: "YNAB env missing" };
  }

  if (!geminiEnabled || !geminiApiKey) {
    return { sent: false, reason: "GEMINI_API_KEY not configured" };
  }

  // Initialize YNAB client and fetch categories/payees
  const client = createYnabClient({ token: ynabToken, budgetId: ynabBudgetId });

  try {
    await ensureCache(client, ynabBudgetId);
  } catch (err) {
    console.error("Failed to fetch YNAB data:", err);
    return {
      sent: false,
      reason: "Failed to fetch YNAB data",
      detail: String(err),
    };
  }

  const categories = getAllCategoryNames();
  const payees = getAllPayeeNames();

  // Parse SMS with Gemini AI
  // Pass sender so AI can determine same_network vs cross_network transfers
  const geminiResult = await parseWithGemini(text, geminiApiKey, {
    categories,
    payees,
    receivedAt: receivedAtIso,
    sender,
  });

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

  // Check if this is a transaction
  if (!aiParsed.is_transaction) {
    return {
      sent: false,
      reason: "Not a transaction",
      detail: aiParsed.reason,
      ai_parsed: aiParsed,
      ai_raw: geminiResult.raw_response,
    };
  }

  // Validate required fields
  if (aiParsed.amount === null || aiParsed.amount === undefined) {
    return {
      sent: false,
      reason: "AI could not extract amount",
      ai_parsed: aiParsed,
    };
  }

  if (!aiParsed.direction) {
    return {
      sent: false,
      reason: "AI could not determine direction",
      ai_parsed: aiParsed,
    };
  }

  // Resolve YNAB account
  const routing = await resolveAccountId(text, sender, client, ynabBudgetId);

  if (!routing.accountId) {
    return { sent: false, reason: "No account resolved", ai_parsed: aiParsed };
  }

  // Look up category and payee IDs
  const categoryId = aiParsed.category
    ? getCategoryIdByName(aiParsed.category)
    : undefined;

  let payeeId: string | undefined;
  let payeeMatched = false;
  if (aiParsed.payee) {
    payeeId = getPayeeIdByName(aiParsed.payee);
    payeeMatched = !!payeeId;
  }

  // Generate import ID for deduplication
  const amountMilli = toMilliunits(aiParsed.amount);
  const importId = await makeImportId({
    sender,
    date: receivedAtIso,
    amountMilli,
    text,
  });

  // Build transaction
  const sign = getSign(aiParsed.direction);
  const memo = aiParsed.memo ?? text.slice(0, 200);

  const transaction: Record<string, unknown> = {
    account_id: routing.accountId,
    date: receivedAtIso.slice(0, 10),
    amount: amountMilli * sign,
    memo,
    cleared: "cleared",
    approved: false,
    import_id: importId,
  };

  if (payeeId) transaction.payee_id = payeeId;
  if (categoryId) transaction.category_id = categoryId;

  // Send to YNAB
  try {
    const res = await client.createTransaction(transaction as any);

    // Create fee transaction if applicable
    let feeInfo: YnabResult["fee"];
    const provider = senderToProvider(sender);

    // Calculate fee for known transfer types
    if (
      aiParsed.direction === "outflow" &&
      aiParsed.transfer_type &&
      aiParsed.transfer_type !== "unknown"
    ) {
      const feeResult = calculateFee(
        provider,
        aiParsed.transfer_type as TransferType,
        aiParsed.amount,
      );

      if (feeResult.fee && feeResult.fee > 0) {
        const feeCategoryId = feeResult.category
          ? getCategoryIdByName(feeResult.category)
          : undefined;
        const feePayeeId = feeResult.payee
          ? getPayeeIdByName(feeResult.payee)
          : undefined;

        const refId = aiParsed.transaction_ref ?? importId;
        const feeImportId = importId.replace(/^sms:/, "fee:");

        const feeTransaction: Record<string, unknown> = {
          account_id: routing.accountId,
          date: receivedAtIso.slice(0, 10),
          amount: -toMilliunits(feeResult.fee),
          memo: `Transaction Fee: Ref: ${refId}`,
          cleared: "cleared",
          approved: false,
          import_id: feeImportId,
        };

        if (feePayeeId) feeTransaction.payee_id = feePayeeId;
        if (feeCategoryId) feeTransaction.category_id = feeCategoryId;

        try {
          const feeRes = await client.createTransaction(feeTransaction as any);
          feeInfo = {
            amount: feeResult.fee,
            payee: feeResult.payee,
            transaction_id: feeRes.data.transaction_ids?.[0],
            transfer_type: aiParsed.transfer_type,
          };
        } catch (feeErr) {
          console.error("Failed to create fee transaction:", feeErr);
        }
      }
    }

    // Create placeholder fee for Absa unknown transfers
    if (
      provider === "absa" &&
      aiParsed.direction === "outflow" &&
      (!aiParsed.transfer_type || aiParsed.transfer_type === "unknown") &&
      !feeInfo
    ) {
      const FEE_CATEGORY_NAME = Deno.env.get("FEE_CATEGORY_NAME") || null;
      const placeholderCategoryId = FEE_CATEGORY_NAME
        ? getCategoryIdByName(FEE_CATEGORY_NAME)
        : undefined;
      const absaPayeeId = getPayeeIdByName("Absa Bank");
      const placeholderFeeImportId = importId.replace(/^sms:/, "plt:");

      const placeholderFeeTransaction: Record<string, unknown> = {
        account_id: routing.accountId,
        date: receivedAtIso.slice(0, 10),
        amount: -toMilliunits(10),
        memo: "Transfer Fee (estimated K10) - verify & adjust amount",
        cleared: "cleared",
        approved: false,
        import_id: placeholderFeeImportId,
      };

      if (absaPayeeId) placeholderFeeTransaction.payee_id = absaPayeeId;
      if (placeholderCategoryId) {
        placeholderFeeTransaction.category_id = placeholderCategoryId;
      }

      try {
        const placeholderRes = await client.createTransaction(
          placeholderFeeTransaction as any,
        );
        feeInfo = {
          amount: 10,
          payee: "Absa Bank",
          transaction_id: placeholderRes.data.transaction_ids?.[0],
          transfer_type: "placeholder",
        };
      } catch (placeholderErr) {
        console.error("Failed to create placeholder fee:", placeholderErr);
      }
    }

    // Create SMS notification fee if applicable
    let smsFeeInfo: YnabResult["sms_fee"];
    const smsNotificationFee = getSmsNotificationFee(provider);

    if (smsNotificationFee.fee && smsNotificationFee.fee > 0) {
      const smsFeeCategoryId = smsNotificationFee.category
        ? getCategoryIdByName(smsNotificationFee.category)
        : undefined;
      const smsFeePayeeId = smsNotificationFee.payee
        ? getPayeeIdByName(smsNotificationFee.payee)
        : undefined;

      const refId = aiParsed.transaction_ref ?? importId;
      const smsFeeImportId = importId.replace(/^sms:/, "ntf:");

      const smsFeeTransaction: Record<string, unknown> = {
        account_id: routing.accountId,
        date: receivedAtIso.slice(0, 10),
        amount: -toMilliunits(smsNotificationFee.fee),
        memo: `SMS Notification Fee: Ref: ${refId}`,
        cleared: "cleared",
        approved: false,
        import_id: smsFeeImportId,
      };

      if (smsFeePayeeId) smsFeeTransaction.payee_id = smsFeePayeeId;
      if (smsFeeCategoryId) smsFeeTransaction.category_id = smsFeeCategoryId;

      try {
        const smsFeeRes = await client.createTransaction(
          smsFeeTransaction as any,
        );
        smsFeeInfo = {
          amount: smsNotificationFee.fee,
          payee: smsNotificationFee.payee,
          transaction_id: smsFeeRes.data.transaction_ids?.[0],
        };
      } catch (smsFeeErr) {
        console.error("Failed to create SMS fee:", smsFeeErr);
      }
    }

    return {
      sent: true,
      account: routing.accountName,
      category: aiParsed.category ?? undefined,
      payee: payeeMatched ? (aiParsed.payee ?? undefined) : undefined,
      payee_matched: payeeMatched,
      payee_extracted: aiParsed.payee ?? undefined,
      memo,
      amount: aiParsed.amount,
      direction: aiParsed.direction,
      transaction_ids: res.data.transaction_ids,
      duplicate_import_ids: res.data.duplicate_import_ids,
      fee: feeInfo,
      sms_fee: smsFeeInfo,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
