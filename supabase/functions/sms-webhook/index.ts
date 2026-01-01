/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SMS WEBHOOK — Supabase Edge Function
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Receives SMS data from iOS Shortcuts and creates transactions in YNAB.
 * Uses Google Gemini AI to intelligently parse SMS messages.
 *
 * NEW: AI now matches against your actual YNAB categories and payees!
 *
 * Endpoint: POST /functions/v1/sms-webhook
 *
 * Flow:
 * 1. Validate webhook secret (if configured)
 * 2. Parse the incoming SMS payload
 * 3. Fetch YNAB categories and payees for AI matching
 * 4. Send SMS to Gemini AI (with your YNAB data for matching)
 * 5. Route to correct YNAB account based on sender
 * 6. Create the transaction in YNAB
 *
 * Configuration: supabase/functions/_shared/config.ts
 */

// Edge runtime types so Deno understands the Supabase environment.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Shared modules.
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
import {
  findMatchingTransaction,
  isSupabaseConfigured,
  markFeeApplied,
  storeSmsContext,
} from "../_shared/supabase-client.ts";

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
  payee?: string; // Only set if matched to existing YNAB payee
  payee_matched?: boolean; // Whether payee was matched (vs left blank)
  payee_extracted?: string; // What AI extracted from SMS (for reference)
  memo?: string;
  amount?: number;
  direction?: string;
  transaction_ids?: string[];
  duplicate_import_ids?: string[];
  // Transaction fee details (if applicable)
  fee?: {
    amount: number; // Fee amount in ZMW
    payee: string | null; // Fee payee (e.g., "Airtel")
    transaction_id?: string; // YNAB transaction ID for the fee
    transfer_type?: string; // Type of transfer that triggered the fee
  };
  // SMS notification fee details (if applicable, e.g., ABSA K0.50 per SMS)
  sms_fee?: {
    amount: number; // SMS notification fee in ZMW
    payee: string | null; // Fee payee (e.g., "Absa")
    transaction_id?: string; // YNAB transaction ID for the SMS fee
  };
  // Correlation info (for multi-SMS transactions like ABSA)
  correlation?: {
    is_follow_up: boolean; // TRUE if this was a follow-up SMS
    correlated_with?: string; // ID of the primary transaction it was linked to
    fee_applied_to_primary?: boolean; // TRUE if we applied transfer fee to original txn
  };
  // AI parsing output for debugging
  ai_parsed?: GeminiParsedSms;
  ai_raw?: string;
}

/**
 * Processes an SMS and creates a transaction in YNAB.
 * Uses Gemini AI for intelligent SMS parsing with YNAB category/payee matching.
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
  // Initialize YNAB client and fetch categories/payees FIRST.
  // We need these for AI matching before calling Gemini.
  // ─────────────────────────────────────────────────────────────────────────
  const client = createYnabClient({ token: ynabToken, budgetId: ynabBudgetId });

  try {
    await ensureCache(client, ynabBudgetId);
  } catch (err) {
    console.error("Failed to fetch YNAB data:", err);
    return {
      sent: false,
      reason: "Failed to fetch YNAB accounts/categories/payees",
      detail: String(err),
    };
  }

  // Get category and payee names for AI matching
  const categories = getAllCategoryNames();
  const payees = getAllPayeeNames();

  // ─────────────────────────────────────────────────────────────────────────
  // Call Gemini AI to parse the SMS (with YNAB data for matching).
  // Pass receivedAt so AI can include time in memo (fallback if not in SMS).
  // ─────────────────────────────────────────────────────────────────────────
  const geminiResult = await parseWithGemini(text, geminiApiKey, {
    categories,
    payees,
    receivedAt: receivedAtIso,
  });

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
  // Handle follow-up SMS (e.g., ABSA SMS2 with phone number but no amount).
  // These provide additional details that help determine transfer type.
  // ─────────────────────────────────────────────────────────────────────────
  if (aiParsed.is_follow_up) {
    console.log("Follow-up SMS detected, attempting correlation...");

    // Only try correlation if Supabase is configured
    if (!isSupabaseConfigured()) {
      console.log("Supabase not configured - cannot correlate follow-up SMS");
      return {
        sent: false,
        reason: "Follow-up SMS cannot be correlated (Supabase not configured)",
        ai_parsed: aiParsed,
        ai_raw: geminiResult.raw_response,
      };
    }

    // Try to find the primary transaction (usually the first SMS with amount)
    const primaryTxn = await findMatchingTransaction(sender);

    if (!primaryTxn) {
      console.log("No recent primary transaction found to correlate with");
      return {
        sent: false,
        reason: "Follow-up SMS but no primary transaction found to correlate",
        ai_parsed: aiParsed,
        ai_raw: geminiResult.raw_response,
      };
    }

    console.log(
      `Found primary transaction: K${primaryTxn.amount} from ${primaryTxn.received_at}`,
    );

    // Determine transfer type from recipient phone number (if available)
    let transferType = aiParsed.transfer_type;
    if (
      (!transferType || transferType === "unknown") &&
      aiParsed.recipient_phone
    ) {
      transferType = determineTransferTypeFromPhone(aiParsed.recipient_phone);
      console.log(
        `Determined transfer type from phone ${aiParsed.recipient_phone}: ${transferType}`,
      );
    }

    // If we can determine transfer type, create the fee transaction
    if (
      transferType &&
      transferType !== "unknown" &&
      primaryTxn.ynab_account_id
    ) {
      const provider = senderToProvider(sender);
      const feeResult = calculateFee(
        provider,
        transferType as TransferType,
        primaryTxn.amount ?? 0,
      );

      if (feeResult.fee && feeResult.fee > 0) {
        console.log(
          `Creating correlated fee: K${feeResult.fee} for ${provider}/${transferType}`,
        );

        // Initialize YNAB client for fee creation
        const client = createYnabClient({
          token: ynabToken!,
          budgetId: ynabBudgetId!,
        });

        // Look up category ID for fees
        const feeCategoryId = feeResult.category
          ? getCategoryIdByName(feeResult.category)
          : undefined;

        // Look up payee ID for fee provider
        const feePayeeId = feeResult.payee
          ? getPayeeIdByName(feeResult.payee)
          : undefined;

        // Create unique fee import ID
        const feeImportId = primaryTxn.import_id?.replace(/^sms:/, "xfr:") ??
          `xfr:${Date.now()}`;

        const feeTransaction: Record<string, unknown> = {
          account_id: primaryTxn.ynab_account_id,
          date: receivedAtIso.slice(0, 10),
          amount: -toMilliunits(feeResult.fee),
          memo: `Transfer Fee (${transferType}): Ref: ${
            primaryTxn.import_id ?? "correlated"
          }`,
          cleared: "cleared",
          approved: false,
          import_id: feeImportId,
        };

        if (feePayeeId) feeTransaction.payee_id = feePayeeId;
        if (feeCategoryId) feeTransaction.category_id = feeCategoryId;

        try {
          const feeRes = await client.createTransaction(feeTransaction as any);

          // Mark primary transaction as fee applied
          if (primaryTxn.id) {
            await markFeeApplied(primaryTxn.id);
          }

          return {
            sent: true,
            reason: "Correlated fee created from follow-up SMS",
            fee: {
              amount: feeResult.fee,
              payee: feeResult.payee,
              transaction_id: feeRes.data.transaction_ids?.[0],
              transfer_type: transferType,
            },
            correlation: {
              is_follow_up: true,
              correlated_with: primaryTxn.id,
              fee_applied_to_primary: true,
            },
            ai_parsed: aiParsed,
            ai_raw: geminiResult.raw_response,
          };
        } catch (feeErr) {
          console.error("Failed to create correlated fee:", feeErr);
          return {
            sent: false,
            reason: "Failed to create correlated fee transaction",
            detail: String(feeErr),
            correlation: { is_follow_up: true, correlated_with: primaryTxn.id },
            ai_parsed: aiParsed,
            ai_raw: geminiResult.raw_response,
          };
        }
      } else {
        console.log(`No fee configured for ${provider}/${transferType}`);
        return {
          sent: false,
          reason:
            "Follow-up correlated but no fee configured for transfer type",
          correlation: { is_follow_up: true, correlated_with: primaryTxn.id },
          ai_parsed: aiParsed,
          ai_raw: geminiResult.raw_response,
        };
      }
    }

    // Follow-up without actionable data
    return {
      sent: false,
      reason: "Follow-up SMS processed but no action needed",
      correlation: { is_follow_up: true, correlated_with: primaryTxn.id },
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
  // Look up category ID from AI's matched category.
  // AI should return an exact category name from our list, or null.
  // ─────────────────────────────────────────────────────────────────────────
  let categoryId: string | undefined;
  if (aiParsed.category) {
    categoryId = getCategoryIdByName(aiParsed.category);
    if (!categoryId) {
      console.warn(
        `AI suggested category "${aiParsed.category}" but it wasn't found in YNAB`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Look up payee ID ONLY if it matches an existing YNAB payee.
  // We NEVER create new payees — user's payee list is carefully organized.
  // If no match, payee stays blank and the extracted name goes in the memo.
  // ─────────────────────────────────────────────────────────────────────────
  let payeeId: string | undefined;
  let payeeMatched = false;
  if (aiParsed.payee) {
    payeeId = getPayeeIdByName(aiParsed.payee);
    payeeMatched = !!payeeId;
    if (!payeeMatched) {
      console.log(
        `Payee "${aiParsed.payee}" not found in YNAB — leaving blank (no new payee created)`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generate import ID for deduplication.
  // Uses FULL timestamp (not just date) so same-amount transfers at different
  // times get unique IDs. This fixes Absa's generic SMS (no transaction ID).
  // ─────────────────────────────────────────────────────────────────────────
  const amountMilli = toMilliunits(aiParsed.amount);
  const importId = await makeImportId({
    sender,
    date: receivedAtIso, // Full timestamp, not just date!
    amountMilli,
    text,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Build the YNAB transaction.
  // ─────────────────────────────────────────────────────────────────────────
  const sign = getSign(aiParsed.direction);

  // Use AI-generated memo if available, otherwise fall back to raw SMS
  const memo = aiParsed.memo ?? text.slice(0, 200);

  const transaction: Record<string, unknown> = {
    account_id: routing.accountId,
    date: receivedAtIso.slice(0, 10),
    amount: amountMilli * sign,
    memo,
    cleared: "cleared",
    approved: false, // Keep manual approval for safety
    import_id: importId,
  };

  // ONLY use payee_id if we matched an existing payee.
  // We NEVER set payee_name — that would create a new payee in YNAB.
  if (payeeId) {
    transaction.payee_id = payeeId;
  }
  // If no match, payee stays blank. The extracted name is already in the memo.

  // Add category if matched
  if (categoryId) {
    transaction.category_id = categoryId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Send to YNAB.
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const res = await client.createTransaction(transaction as any);

    // ─────────────────────────────────────────────────────────────────────────
    // Store SMS context for potential correlation with follow-up messages.
    // This is used for multi-SMS transactions (e.g., ABSA sends 2 SMS per txn).
    // The follow-up SMS will find this record and create the transfer fee.
    // ─────────────────────────────────────────────────────────────────────────
    if (isSupabaseConfigured()) {
      try {
        await storeSmsContext({
          sender,
          sms_text: text,
          received_at: receivedAtIso,
          amount: aiParsed.amount,
          direction: aiParsed.direction,
          account_ending: aiParsed.account_ending ?? null,
          ynab_transaction_id: res.data.transaction_ids?.[0] ?? null,
          ynab_account_id: routing.accountId ?? null,
          import_id: importId,
          is_primary: true,
          fee_applied: false,
        });
        console.log("SMS context stored for potential correlation");
      } catch (storeErr) {
        // Log but don't fail - correlation is optional
        console.error("Failed to store SMS context:", storeErr);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Create fee transaction (if applicable).
    // Fees only apply to outflows (when YOU send money, not when you receive).
    // ─────────────────────────────────────────────────────────────────────────
    let feeInfo: {
      amount: number;
      payee: string | null;
      transaction_id?: string;
      transfer_type?: string;
    } | undefined;

    // Determine the provider from SMS sender (used for both transaction and SMS fees)
    const provider = senderToProvider(sender);

    // Only calculate transaction fees for outflows with a known transfer type
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

      // Only create fee transaction if fee is > 0 and configured
      if (feeResult.fee && feeResult.fee > 0) {
        console.log(
          `Fee calculated: K${feeResult.fee} for ${provider}/${aiParsed.transfer_type}`,
        );

        // Look up category ID for fees (e.g., "Bank Transaction & Fees")
        const feeCategoryId = feeResult.category
          ? getCategoryIdByName(feeResult.category)
          : undefined;

        // Look up payee ID for fee provider (e.g., "Airtel")
        const feePayeeId = feeResult.payee
          ? getPayeeIdByName(feeResult.payee)
          : undefined;

        // Build the fee transaction
        // Use transaction_ref from AI if available, otherwise use import ID
        const refId = aiParsed.transaction_ref ?? importId;

        // Create a shorter fee import ID to fit YNAB's 36 char limit
        // Original importId is "sms:XXXX..." (36 chars), so we replace prefix
        // Result: "fee:XXXX..." (36 chars) — unique and within limit
        const feeImportId = importId.replace(/^sms:/, "fee:");

        const feeTransaction: Record<string, unknown> = {
          account_id: routing.accountId,
          date: receivedAtIso.slice(0, 10),
          amount: -toMilliunits(feeResult.fee), // Always outflow (negative)
          memo: `Transaction Fee: Ref: ${refId}`,
          cleared: "cleared",
          approved: false,
          import_id: feeImportId, // Unique ID to prevent duplicate fees
        };

        // Add payee if matched
        if (feePayeeId) {
          feeTransaction.payee_id = feePayeeId;
        }

        // Add category if matched
        if (feeCategoryId) {
          feeTransaction.category_id = feeCategoryId;
        }

        // Create the fee transaction in YNAB
        try {
          const feeRes = await client.createTransaction(feeTransaction as any);
          feeInfo = {
            amount: feeResult.fee,
            payee: feeResult.payee,
            transaction_id: feeRes.data.transaction_ids?.[0],
            transfer_type: aiParsed.transfer_type,
          };
          console.log(`Fee transaction created: K${feeResult.fee}`);
        } catch (feeErr) {
          // Log but don't fail the whole request if fee creation fails
          console.error("Failed to create fee transaction:", feeErr);
        }
      } else if (feeResult.configured && feeResult.fee === 0) {
        // Fee is configured as FREE (e.g., airtime purchases)
        console.log(
          `No fee for ${provider}/${aiParsed.transfer_type} (configured as free)`,
        );
      } else if (!feeResult.configured) {
        // Fee not configured for this combination
        console.log(
          `Fee not configured for ${provider}/${aiParsed.transfer_type}`,
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Create SMS notification fee (if applicable).
    // Some banks (like ABSA) charge per SMS notification received.
    // This is separate from transaction fees — it's the cost of the SMS itself.
    // ─────────────────────────────────────────────────────────────────────────
    let smsFeeInfo:
      | { amount: number; payee: string | null; transaction_id?: string }
      | undefined;

    const smsNotificationFee = getSmsNotificationFee(provider);
    if (smsNotificationFee.fee && smsNotificationFee.fee > 0) {
      console.log(
        `SMS notification fee: K${smsNotificationFee.fee} for ${provider}`,
      );

      // Look up category ID for the SMS fee
      const smsFeeCategoryId = smsNotificationFee.category
        ? getCategoryIdByName(smsNotificationFee.category)
        : undefined;

      // Look up payee ID for the SMS fee
      const smsFeePayeeId = smsNotificationFee.payee
        ? getPayeeIdByName(smsNotificationFee.payee)
        : undefined;

      // Build the SMS notification fee transaction
      // Use transaction_ref from AI if available, otherwise use import ID
      const refId = aiParsed.transaction_ref ?? importId;

      // Create unique import ID for SMS fee: "ntf:XXXX..." (notification fee)
      const smsFeeImportId = importId.replace(/^sms:/, "ntf:");

      const smsFeeTransaction: Record<string, unknown> = {
        account_id: routing.accountId,
        date: receivedAtIso.slice(0, 10),
        amount: -toMilliunits(smsNotificationFee.fee), // Always outflow (negative)
        memo: `SMS Notification Fee: Ref: ${refId}`,
        cleared: "cleared",
        approved: false,
        import_id: smsFeeImportId,
      };

      // Add payee if matched
      if (smsFeePayeeId) {
        smsFeeTransaction.payee_id = smsFeePayeeId;
      }

      // Add category if matched
      if (smsFeeCategoryId) {
        smsFeeTransaction.category_id = smsFeeCategoryId;
      }

      // Create the SMS fee transaction in YNAB
      try {
        const smsFeeRes = await client.createTransaction(
          smsFeeTransaction as any,
        );
        smsFeeInfo = {
          amount: smsNotificationFee.fee,
          payee: smsNotificationFee.payee,
          transaction_id: smsFeeRes.data.transaction_ids?.[0],
        };
        console.log(
          `SMS notification fee transaction created: K${smsNotificationFee.fee}`,
        );
      } catch (smsFeeErr) {
        // Log but don't fail the whole request if SMS fee creation fails
        console.error("Failed to create SMS notification fee:", smsFeeErr);
      }
    }

    return {
      sent: true,
      account: routing.accountName,
      category: aiParsed.category ?? undefined,
      // Only show payee if it was matched to an existing YNAB payee
      payee: payeeMatched ? (aiParsed.payee ?? undefined) : undefined,
      payee_matched: payeeMatched,
      // Always show what AI extracted (for reference/debugging)
      payee_extracted: aiParsed.payee ?? undefined,
      memo,
      amount: aiParsed.amount,
      direction: aiParsed.direction,
      transaction_ids: res.data.transaction_ids,
      duplicate_import_ids: res.data.duplicate_import_ids,
      fee: feeInfo, // Include transaction fee info if created
      sms_fee: smsFeeInfo, // Include SMS notification fee info if created
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

/**
 * Determines the transfer type based on Zambian phone number prefixes.
 * Used when correlating follow-up SMS to determine if it's a mobile money transfer.
 *
 * Zambian Phone Prefix Rules:
 * - Airtel: 097, 077, 97, 77
 * - MTN: 096, 076, 96, 76
 * - Zamtel: 095, 075, 95, 75
 *
 * @param phone - Phone number string (e.g., "260770284890", "0770284890", "770284890")
 * @returns Transfer type: "to_mobile" if it's a mobile money number, "unknown" otherwise
 */
function determineTransferTypeFromPhone(
  phone: string,
): "to_mobile" | "same_network" | "cross_network" | "unknown" {
  // Clean up phone number - remove spaces, dashes, country code prefix
  const cleaned = phone.replace(/[\s-]/g, "").replace(/^260/, "");

  // Check if it starts with a mobile money prefix
  // Leading 0 is optional, so check both with and without it
  const mobileMoneyPrefixes = [
    // Airtel
    "097",
    "077",
    "97",
    "77",
    // MTN
    "096",
    "076",
    "96",
    "76",
    // Zamtel
    "095",
    "075",
    "95",
    "75",
  ];

  // Check if the phone matches any mobile money prefix
  const isMobileNumber = mobileMoneyPrefixes.some((prefix) =>
    cleaned.startsWith(prefix)
  );

  if (isMobileNumber) {
    // Bank → Mobile Money transfer (e.g., ABSA to Airtel/MTN/Zamtel)
    return "to_mobile";
  }

  // Not a recognizable mobile money number
  return "unknown";
}
