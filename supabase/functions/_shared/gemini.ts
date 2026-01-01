/**
 * GEMINI AI CLIENT — Parse SMS messages using Google's Gemini LLM.
 *
 * Uses AI to intelligently parse SMS messages and extract transaction details.
 * Matches against your actual YNAB categories and payees for accurate categorization.
 *
 * Free tier: 15 requests/minute, 1 million tokens/day (more than enough for personal use)
 */

// The structured response from Gemini
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
    transfer_type:
        | "same_network"
        | "cross_network"
        | "to_bank"
        | "to_mobile"
        | "withdrawal"
        | "airtime"
        | "bill_payment"
        | "pos"
        | "unknown"
        | null;
}

export interface GeminiResult {
    success: boolean;
    parsed?: GeminiParsedSms;
    error?: string;
    raw_response?: string;
}

export interface AiContext {
    categories: string[];
    payees: string[];
    receivedAt?: string;
}

// Gemini API config
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Builds the prompt for Gemini with user's YNAB data.
 */
function buildPrompt(smsText: string, context: AiContext): string {
    const categoryList = context.categories.slice(0, 100).join(", ");
    const payeeList = context.payees.slice(0, 200).join(", ");

    // Convert receivedAt to Zambia timezone (CAT = UTC+2)
    let fallbackTime = "";
    if (context.receivedAt) {
        try {
            const date = new Date(context.receivedAt);
            const zambiaOffset = 2 * 60 * 60 * 1000;
            const localDate = new Date(date.getTime() + zambiaOffset);
            const hours = String(localDate.getUTCHours()).padStart(2, "0");
            const minutes = String(localDate.getUTCMinutes()).padStart(2, "0");
            fallbackTime = `${hours}:${minutes}`;
        } catch {
            // Ignore parsing errors
        }
    }

    return `You are a financial SMS parser for Zambian banks and mobile money services.

TASK: Analyze this SMS and extract transaction details.

USER'S YNAB CATEGORIES:
${categoryList}

USER'S EXISTING YNAB PAYEES:
${payeeList}

RULES:

1. is_transaction:
   - TRUE only for real money movements (sent, received, paid, withdrawn, deposited, credited, debited, purchased, top-up)
   - FALSE for: balance checks, promotions, OTPs, conversations, loan offers

2. amount: Extract the TRANSACTION amount, NOT the remaining balance

3. direction:
   - "inflow" = money received, deposited, credited, refunded
   - "outflow" = money sent, paid, withdrawn, purchased, debited

4. payee:
   - Extract the FULL person/business name ONLY if EXPLICITLY mentioned in the SMS
   - Do NOT guess or infer a payee — if not named, set payee to null
   - Do NOT abbreviate names
   - Check if it matches an existing payee from the list (fuzzy match OK)
   - If MATCHED: set payee to the EXACT name from the payee list, is_new_payee = false
   - If NOT MATCHED: set payee to the FULL name you extracted, is_new_payee = true
   - If NO payee mentioned: payee = null, is_new_payee = false

5. category:
   - MUST exactly match one of the categories listed above (case-insensitive OK)
   - If unsure, set to null
   - Generic bank debits/credits → category = null
   - Transfers between accounts → category = null
   - Only categorize when CONFIDENT about the purchase type

6. memo: Format as "[Action] [Payee] | [HH:MM] | Ref: [ID] | Bal: [Balance]"
   - Use the FULL payee name (do NOT abbreviate)
   - ALWAYS include transaction TIME (HH:MM format)
   - Look for time in SMS first, if not found use: ${fallbackTime}
   - Do NOT include dates, only TIME

7. transaction_ref: Extract the transaction/reference ID if present
   - Look for patterns like "TID:", "Ref:", "Txn ID:"
   - Return ONLY the ID part, not the label

8. transfer_type: Determine the type for fee calculation:
   - "same_network" = Same provider (Airtel→Airtel, MTN→MTN)
   - "cross_network" = Different mobile money (Airtel→MTN)
   - "to_bank" = Mobile money → Bank account
   - "to_mobile" = Bank → Mobile money
   - "withdrawal" = Cash withdrawal at agent or ATM
   - "airtime" = Airtime or data purchase
   - "bill_payment" = Utility bills, merchants
   - "pos" = Point of sale / debit card purchase (look for "POS" in SMS)
   - "unknown" = Can't determine

   ZAMBIAN PHONE PREFIXES:
   - Airtel: 097, 077, 97, 77
   - MTN: 096, 076, 96, 76
   - Zamtel: 095, 075, 95, 75

   DETECTION HINTS:
   - "POS" → pos
   - "ATM" or "withdraw" → withdrawal
   - "top-up" → airtime
   - "till" → bill_payment

SMS MESSAGE:
"""
${smsText}
"""

FALLBACK TIME (use if no time in SMS): ${fallbackTime}

Respond with JSON only:
{
  "is_transaction": true/false,
  "reason": "brief explanation",
  "amount": number or null,
  "direction": "inflow" or "outflow" or null,
  "payee": "matched or new payee name" or null,
  "is_new_payee": true/false,
  "category": "exact category name from list" or null,
  "memo": "clean description" or null,
  "transaction_ref": "reference ID" or null,
  "transfer_type": "same_network" | "cross_network" | "to_bank" | "to_mobile" | "withdrawal" | "airtime" | "bill_payment" | "pos" | "unknown" or null
}`;
}

/**
 * Parses an SMS message using Gemini AI.
 */
export async function parseWithGemini(
    smsText: string,
    apiKey: string,
    context: AiContext,
): Promise<GeminiResult> {
    const requestBody = {
        contents: [{ parts: [{ text: buildPrompt(smsText, context) }] }],
        generationConfig: {
            temperature: 0.1,
            topP: 0.8,
            topK: 40,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
        },
    };

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
            };
        }

        // Clean markdown code blocks if present
        const cleanedJson = textContent
            .replace(/```json\s*/g, "")
            .replace(/```\s*/g, "")
            .trim();

        try {
            const parsed: GeminiParsedSms = JSON.parse(cleanedJson);

            if (typeof parsed.is_transaction !== "boolean") {
                return {
                    success: false,
                    error: "Invalid response: missing is_transaction field",
                    raw_response: textContent,
                };
            }

            if (parsed.is_new_payee === undefined) {
                parsed.is_new_payee = true;
            }

            return { success: true, parsed, raw_response: textContent };
        } catch (parseError) {
            return {
                success: false,
                error: `Failed to parse Gemini JSON: ${parseError}`,
                raw_response: textContent,
            };
        }
    } catch (fetchError) {
        return {
            success: false,
            error: `Network error calling Gemini: ${fetchError}`,
        };
    }
}

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
