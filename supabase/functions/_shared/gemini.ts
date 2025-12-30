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
 * NEW: AI now matches against your actual YNAB categories and payees!
 * - Categories are matched exactly or left blank if uncertain
 * - Payees are fuzzy-matched against existing payees
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

    // Payee name — should match an existing YNAB payee if possible, or be a new name
    payee: string | null;

    // Whether the payee is a new payee (not in existing YNAB payees)
    is_new_payee: boolean;

    // Category name — must EXACTLY match one of the provided YNAB categories, or null
    category: string | null;

    // Clean, human-friendly memo for YNAB
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

/**
 * Context passed to the AI for better matching.
 */
export interface AiContext {
    categories: string[]; // User's YNAB category names
    payees: string[]; // User's YNAB payee names
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
 * Builds the prompt to send to Gemini.
 * Includes the user's actual YNAB categories and payees for matching.
 */
function buildPrompt(smsText: string, context: AiContext): string {
    // Limit lists to avoid token limits (take first 100 of each)
    const categoryList = context.categories.slice(0, 100).join(", ");
    const payeeList = context.payees.slice(0, 200).join(", ");

    return `You are a financial SMS parser for Zambian banks and mobile money services.

TASK: Analyze this SMS and extract transaction details.

USER'S YNAB CATEGORIES:
${categoryList}

USER'S EXISTING YNAB PAYEES:
${payeeList}

RULES:

1. is_transaction:
   - TRUE only for real money movements (sent, received, paid, withdrawn, deposited, credited, debited, purchased, top-up)
   - FALSE for: balance checks, promotions ("WIN ZMW 5,000!"), OTPs, conversations, loan offers

2. amount: Extract the TRANSACTION amount, NOT the remaining balance

3. direction:
   - "inflow" = money received, deposited, credited, refunded
   - "outflow" = money sent, paid, withdrawn, purchased, debited

4. payee:
   - Extract the person/business name if mentioned in the SMS
   - Check if it matches an existing payee from the list above (fuzzy match OK)
   - Examples: "Harry Banda" → "H. Banda", "shoprite" → "Shoprite"
   - If MATCHED: set payee to the EXACT name from the payee list, set is_new_payee = false
   - If NOT MATCHED: still set payee to what you extracted (for reference), set is_new_payee = true
   - Note: We only use matched payees in YNAB; unmatched names are for memo only

5. category:
   - MUST exactly match one of the categories listed above (case-insensitive OK)
   - If unsure, set to null (user will categorize manually)
   - Common mappings: airtime/data → look for "Airtime" or "Data" category, groceries → "Groceries", etc.

6. memo: Detailed but organized (max 200 chars)
   - Format: "[Action] [Payee/Details] | Ref: [ID] | Bal: [Balance]"
   - Include reference IDs and balance if present
   - Do NOT include promotional text

SMS MESSAGE:
"""
${smsText}
"""

Respond with JSON only:
{
  "is_transaction": true/false,
  "reason": "brief explanation",
  "amount": number or null,
  "direction": "inflow" or "outflow" or null,
  "payee": "matched or new payee name" or null,
  "is_new_payee": true/false,
  "category": "exact category name from list" or null,
  "memo": "clean description" or null
}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN API FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses an SMS message using Gemini AI.
 * Matches against the user's actual YNAB categories and payees.
 *
 * @param smsText - The full SMS message text
 * @param apiKey - Your Gemini API key (from Google AI Studio)
 * @param context - User's YNAB categories and payees for matching
 * @returns GeminiResult with parsed data or error
 */
export async function parseWithGemini(
    smsText: string,
    apiKey: string,
    context: AiContext,
): Promise<GeminiResult> {
    // Build the request payload for Gemini API
    const requestBody = {
        contents: [
            {
                parts: [
                    {
                        text: buildPrompt(smsText, context),
                    },
                ],
            },
        ],
        // Configure generation parameters for consistent JSON output
        generationConfig: {
            temperature: 0.1, // Low temperature for more deterministic responses
            topP: 0.8,
            topK: 40,
            maxOutputTokens: 2048, // Enough for our JSON response
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

            // Default is_new_payee to true if not provided
            if (parsed.is_new_payee === undefined) {
                parsed.is_new_payee = true;
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
