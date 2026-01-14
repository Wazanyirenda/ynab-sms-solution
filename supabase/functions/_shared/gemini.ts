/**
 * GEMINI AI CLIENT — Hybrid SMS parsing (Code + AI)
 *
 * ARCHITECTURE:
 * 1. CODE: Pre-extract deterministic data (amount, balance, time, phone, etc.)
 * 2. AI: Understand context (is_transaction, payee, direction, category)
 * 3. CODE: Post-process (apply aliases, format memo, override with extractions)
 *
 * This hybrid approach improves accuracy, speed, and reduces token costs.
 */

import {
    detectTransferType,
    extractAmount,
    extractBalance,
    extractPhoneAndNetwork,
    extractTime,
    extractTransactionRef,
    formatMemo,
    type MobileNetwork,
    preExtract,
    type PreExtractedData,
    type TransferType,
} from "./extractors.ts";
import { applyPayeeAlias } from "./payee-aliases.ts";
import { senderToProvider } from "./fee-calculator.ts";

// ============================================================================
// TYPES
// ============================================================================

// The structured response (final output after post-processing)
export interface GeminiParsedSms {
    is_transaction: boolean;
    reason: string;
    amount: number | null;
    direction: "inflow" | "outflow" | null;
    payee: string | null;
    is_new_payee: boolean;
    category: string | null;
    memo: string | null;
    transaction_ref: string | null;
    balance: number | null;
    transfer_type: TransferType | null;
}

export interface GeminiResult {
    success: boolean;
    parsed?: GeminiParsedSms;
    error?: string;
    raw_response?: string;
    // Debug info for the hybrid extraction
    pre_extracted?: PreExtractedData;
}

export interface AiContext {
    categories: string[];
    payees: string[];
    receivedAt?: string;
    sender?: string;
}

// What AI returns (before post-processing)
interface AiResponse {
    is_transaction: boolean;
    reason: string;
    direction: "inflow" | "outflow" | null;
    payee: string | null;
    is_new_payee: boolean;
    category: string | null;
    action: string; // For memo: "Sent", "Received", "Purchased", etc.
}

// ============================================================================
// CONFIG
// ============================================================================

// Available models: gemini-2.0-flash, gemini-2.5-flash
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ============================================================================
// SIMPLIFIED AI PROMPT
// ============================================================================

/**
 * Builds a simplified prompt for AI.
 * Only asks AI to do what it's good at: understanding context.
 * Deterministic data (amount, balance, time) is extracted in code.
 */
function buildPrompt(smsText: string, context: AiContext): string {
    const categoryList = context.categories.slice(0, 100).join(", ");
    const payeeList = context.payees.slice(0, 200).join(", ");

    return `You are a financial SMS parser. Analyze this SMS and determine:
1. Is this a real transaction? (not promo, OTP, balance check, loan offer)
2. What direction is the money flow? (inflow or outflow)
3. Who is the payee? (person or business name, if mentioned)
4. What category fits? (from the user's list)

USER'S YNAB CATEGORIES:
${categoryList}

USER'S EXISTING YNAB PAYEES:
${payeeList}

RULES:
- is_transaction: TRUE for real money movements, FALSE for promos/OTPs/balance checks
- direction: "inflow" (received/credited) or "outflow" (sent/paid/purchased)
- payee: Extract FULL name if explicitly mentioned, otherwise null
- category: Must EXACTLY match one from the list above, or null if unsure
- action: Short verb for memo (e.g., "Sent", "Received", "Purchased", "Withdrawn", "Paid")

CHECK EXISTING PAYEES:
- If payee matches an existing one (fuzzy OK), use EXACT name from list, is_new_payee = false
- If payee is new, set is_new_payee = true
- If no payee mentioned, payee = null, is_new_payee = false

SMS:
"""
${smsText}
"""

Respond with JSON only:
{
  "is_transaction": true/false,
  "reason": "brief explanation",
  "direction": "inflow" or "outflow" or null,
  "payee": "name" or null,
  "is_new_payee": true/false,
  "category": "exact category name" or null,
  "action": "Sent" or "Received" or "Purchased" etc.
}`;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Parses an SMS using hybrid approach (Code + AI).
 *
 * 1. Pre-extract deterministic data in code (amount, balance, time, etc.)
 * 2. Send simplified prompt to AI for context understanding
 * 3. Post-process: merge code extractions + AI response + aliases
 */
export async function parseWithGemini(
    smsText: string,
    apiKey: string,
    context: AiContext,
): Promise<GeminiResult> {
    // -------------------------------------------------------------------------
    // STEP 1: Pre-extract deterministic data in code
    // -------------------------------------------------------------------------

    // Calculate fallback time from receivedAt
    let fallbackTime = "00:00";
    if (context.receivedAt) {
        try {
            const date = new Date(context.receivedAt);
            const zambiaOffset = 2 * 60 * 60 * 1000; // UTC+2
            const localDate = new Date(date.getTime() + zambiaOffset);
            const hours = String(localDate.getUTCHours()).padStart(2, "0");
            const minutes = String(localDate.getUTCMinutes()).padStart(2, "0");
            fallbackTime = `${hours}:${minutes}`;
        } catch {
            // Ignore parsing errors
        }
    }

    // Determine sender network for transfer type detection
    const senderNetwork: MobileNetwork = context.sender
        ? (senderToProvider(context.sender) as MobileNetwork)
        : "unknown";

    // Pre-extract all deterministic data
    const preExtracted = preExtract(smsText, senderNetwork, fallbackTime);

    // -------------------------------------------------------------------------
    // STEP 2: Call AI for context understanding
    // -------------------------------------------------------------------------

    const requestBody = {
        contents: [{ parts: [{ text: buildPrompt(smsText, context) }] }],
        generationConfig: {
            temperature: 0.1,
            topP: 0.8,
            topK: 40,
            maxOutputTokens: 1024, // Allow more output tokens
            responseMimeType: "application/json",
        },
    };

    let aiResponse: AiResponse;
    let rawResponse: string | undefined;

    try {
        const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            return {
                success: false,
                error:
                    `Gemini API error: ${response.status} ${response.statusText}`,
                raw_response: errorText,
                pre_extracted: preExtracted,
            };
        }

        const geminiResponse = await response.json();
        const textContent = geminiResponse.candidates?.[0]?.content?.parts?.[0]
            ?.text;

        if (!textContent) {
            return {
                success: false,
                error: "No text content in Gemini response",
                raw_response: JSON.stringify(geminiResponse),
                pre_extracted: preExtracted,
            };
        }

        rawResponse = textContent;

        // Clean markdown code blocks if present
        const cleanedJson = textContent
            .replace(/```json\s*/g, "")
            .replace(/```\s*/g, "")
            .trim();

        try {
            aiResponse = JSON.parse(cleanedJson);
        } catch (parseErr) {
            // JSON parsing failed - return error with raw response for debugging
            return {
                success: false,
                error: `Failed to parse AI response: ${parseErr}`,
                raw_response: textContent,
                pre_extracted: preExtracted,
            };
        }

        if (typeof aiResponse.is_transaction !== "boolean") {
            return {
                success: false,
                error: "Invalid response: missing is_transaction field",
                raw_response: textContent,
                pre_extracted: preExtracted,
            };
        }
    } catch (err) {
        return {
            success: false,
            error: `Gemini network error: ${err}`,
            raw_response: rawResponse,
            pre_extracted: preExtracted,
        };
    }

    // -------------------------------------------------------------------------
    // STEP 3: Post-process — merge code extractions + AI response
    // -------------------------------------------------------------------------

    // Apply payee alias if exists
    const finalPayee = applyPayeeAlias(aiResponse.payee);

    // Check if aliased payee matches existing YNAB payee
    let isNewPayee = aiResponse.is_new_payee;
    if (finalPayee && finalPayee !== aiResponse.payee) {
        // Alias was applied - check if it's in payee list
        const payeeLower = finalPayee.toLowerCase();
        const existsInYnab = context.payees.some(
            (p) => p.toLowerCase() === payeeLower,
        );
        isNewPayee = !existsInYnab;
    }

    // Use code-extracted transfer type if available, otherwise default to unknown
    const finalTransferType = preExtracted.transferType ?? "unknown";

    // Format memo in code (consistent formatting)
    const memo = formatMemo(
        aiResponse.action || "Transaction",
        finalPayee,
        preExtracted.time,
        preExtracted.balance,
    );

    // Build final result with code extractions taking priority for deterministic fields
    const parsed: GeminiParsedSms = {
        // From AI (context understanding)
        is_transaction: aiResponse.is_transaction,
        reason: aiResponse.reason,
        direction: aiResponse.direction,
        category: aiResponse.category,

        // From AI + post-processing (payee alias applied)
        payee: finalPayee,
        is_new_payee: isNewPayee,

        // From CODE (deterministic extraction - more reliable)
        amount: preExtracted.amount,
        balance: preExtracted.balance,
        transaction_ref: preExtracted.transactionRef,
        transfer_type: finalTransferType,

        // From CODE (formatted consistently)
        memo,
    };

    return {
        success: true,
        parsed,
        raw_response: rawResponse,
        pre_extracted: preExtracted,
    };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Converts an amount to YNAB milliunits (1000 = ZMW 1.00).
 */
export function toMilliunits(amount: number): number {
    return Math.round(amount * 1000);
}

/**
 * Gets the sign for a transaction direction.
 */
export function getSign(direction: "inflow" | "outflow" | null): 1 | -1 {
    return direction === "inflow" ? 1 : -1;
}
