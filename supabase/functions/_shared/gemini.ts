/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GEMINI AI CLIENT — Parse SMS messages using Google's Gemini LLM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module handles calling the Gemini API to intelligently parse SMS
 * messages and extract transaction details. The LLM can understand context
 * better than regex, handling edge cases like:
 * - Promotional messages mentioning amounts ("WIN ZMW 5,000!")
 * - Casual conversations about money
 * - Unusual message formats from new banks/services
 *
 * Free tier: 15 requests/minute, 1 million tokens/day
 * More than enough for personal use!
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The structured response we expect from Gemini.
 * This is what the LLM will parse from the SMS.
 */
export interface GeminiParsedSms {
    // Is this an actual financial transaction? (not a promo, balance check, or conversation)
    is_transaction: boolean;

    // Explanation of why this is/isn't a transaction (helpful for debugging)
    reason: string;

    // Transaction amount (e.g., 100.50) — null if not a transaction
    amount: number | null;

    // Direction of money flow: "inflow" (received) or "outflow" (sent/paid)
    direction: "inflow" | "outflow" | null;

    // Who the money was sent to or received from (extracted from message)
    payee: string | null;

    // Suggested category based on message content (e.g., "Airtime", "Groceries")
    category_hint: string | null;

    // Clean, human-friendly memo for YNAB (e.g., "Received from Harry Banda via Zamtel")
    memo: string | null;
}

/**
 * Result of calling the Gemini API.
 */
export interface GeminiResult {
    success: boolean;
    parsed?: GeminiParsedSms;
    error?: string;
    raw_response?: string; // Raw response for debugging
}

// ═══════════════════════════════════════════════════════════════════════════
// GEMINI API CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Using Gemini 3 Flash Preview — "most intelligent model built for speed"
// All Gemini models have generous FREE tiers (input & output free of charge)
// Options (all free): gemini-3-flash-preview, gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash
const GEMINI_MODEL = "gemini-3-flash-preview";
const GEMINI_API_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT TEMPLATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The prompt template we send to Gemini.
 * This instructs the LLM on how to parse the SMS and what format to return.
 */
const SYSTEM_PROMPT =
    `You are a financial SMS parser for Zambian banks and mobile money services (Airtel Money, MTN MoMo, Zamtel Money, ABSA, Standard Chartered, etc.).

Your job is to analyze SMS messages and determine:
1. Whether this is an actual financial transaction
2. Extract transaction details if it is

IMPORTANT RULES:
- is_transaction = TRUE only for real money movements (sent, received, paid, withdrawn, deposited, credited, debited, purchased, top-up)
- is_transaction = FALSE for:
  - Balance check notifications (just showing balance, no transaction)
  - Promotional/advertising messages (even if they mention amounts like "WIN ZMW 5,000!")
  - OTP/verification codes
  - General conversations that happen to mention money
  - Loan offers or pre-approval notifications (unless money was actually disbursed)
  
- For amount: Extract the TRANSACTION amount, NOT the remaining balance
- For direction: 
  - "inflow" = money received, deposited, credited, refunded
  - "outflow" = money sent, paid, withdrawn, purchased, debited
- For payee: Extract the name of the person/business if mentioned, otherwise null
- For category_hint: Suggest based on context:
  - "Airtime" for phone credit/data purchases
  - "Transfer" for person-to-person transfers
  - "Groceries" for supermarkets
  - "Utilities" for bills (electricity, water)
  - "Cash Withdrawal" for ATM/agent withdrawals
  - "Bank Fees" for transaction fees
  - null if unclear
- For memo: Write a detailed but organized memo (max 200 chars).
  Format: "[Action] [Payee/Details] | Ref: [ID] | Bal: [Balance]"
  Include transaction/reference IDs and remaining balance if present.
  Examples:
  - "Received from Harry Banda via Zamtel | Ref: 001271716055 | Bal: ZMW 23.98"
  - "Sent to John Doe | TID: PP251230.1234.A12345 | Bal: ZMW 500.00"
  - "Airtime top-up | Txn: RC251230.1234.H12345 | Bal: ZMW 100.00"
  - "POS purchase at Shoprite | Bal: ZMW 1,234.56"
  - "ATM withdrawal | Ref: 123456789"
  Do NOT include promotional text or marketing messages.

Respond with ONLY valid JSON, no markdown or explanation:`;

/**
 * Builds the full prompt to send to Gemini.
 */
function buildPrompt(smsText: string): string {
    return `${SYSTEM_PROMPT}

SMS Message:
"""
${smsText}
"""

Respond with JSON:
{
  "is_transaction": true/false,
  "reason": "brief explanation",
  "amount": number or null,
  "direction": "inflow" or "outflow" or null,
  "payee": "name" or null,
  "category_hint": "category" or null,
  "memo": "clean description" or null
}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN API FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses an SMS message using Gemini AI.
 *
 * @param smsText - The full SMS message text
 * @param apiKey - Your Gemini API key (from Google AI Studio)
 * @returns GeminiResult with parsed data or error
 */
export async function parseWithGemini(
    smsText: string,
    apiKey: string,
): Promise<GeminiResult> {
    // Build the request payload for Gemini API
    const requestBody = {
        contents: [
            {
                parts: [
                    {
                        text: buildPrompt(smsText),
                    },
                ],
            },
        ],
        // Configure generation parameters for consistent JSON output
        generationConfig: {
            temperature: 0.1, // Low temperature for more deterministic responses
            topP: 0.8,
            topK: 40,
            maxOutputTokens: 1024, // Increased to avoid truncation
            responseMimeType: "application/json", // Force JSON output
        },
    };

    try {
        // Call the Gemini API
        const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
        });

        // Handle HTTP errors
        if (!response.ok) {
            const errorText = await response.text();
            return {
                success: false,
                error:
                    `Gemini API error: ${response.status} ${response.statusText}`,
                raw_response: errorText,
            };
        }

        // Parse the Gemini response
        const geminiResponse = await response.json();

        // Extract the text content from Gemini's response structure
        const textContent = geminiResponse.candidates?.[0]?.content?.parts?.[0]
            ?.text;

        if (!textContent) {
            return {
                success: false,
                error: "No text content in Gemini response",
                raw_response: JSON.stringify(geminiResponse),
            };
        }

        // Try to parse the JSON response from Gemini
        // Sometimes Gemini wraps the JSON in markdown code blocks, so we clean that
        const cleanedJson = textContent
            .replace(/```json\s*/g, "")
            .replace(/```\s*/g, "")
            .trim();

        try {
            const parsed: GeminiParsedSms = JSON.parse(cleanedJson);

            // Validate the parsed response has required fields
            if (typeof parsed.is_transaction !== "boolean") {
                return {
                    success: false,
                    error: "Invalid response: missing is_transaction field",
                    raw_response: textContent,
                };
            }

            return {
                success: true,
                parsed,
                raw_response: textContent,
            };
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

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Converts an amount to YNAB milliunits.
 * YNAB uses 1/1000 of the currency unit (e.g., ZMW 10.00 → 10000).
 *
 * @param amount - Amount in normal units (e.g., 10.50)
 * @returns Amount in milliunits (e.g., 10500)
 */
export function toMilliunits(amount: number): number {
    return Math.round(amount * 1000);
}

/**
 * Gets the sign for a transaction direction.
 *
 * @param direction - "inflow" or "outflow"
 * @returns 1 for inflow (positive), -1 for outflow (negative)
 */
export function getSign(direction: "inflow" | "outflow" | null): 1 | -1 {
    return direction === "inflow" ? 1 : -1;
}
