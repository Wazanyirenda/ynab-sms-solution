/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUPABASE CLIENT — Database access for SMS context correlation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module provides database access for storing and retrieving SMS context.
 * Used for correlating multi-SMS transactions (e.g., ABSA sends 2 SMS per txn).
 *
 * The sms_context table stores recent transaction metadata so follow-up SMS
 * can be matched with their primary transaction.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SMS context record for correlation.
 */
export interface SmsContextRecord {
    id?: string;
    sender: string;
    sms_text: string;
    received_at: string;
    amount?: number | null;
    direction?: string | null;
    account_ending?: string | null;
    ynab_transaction_id?: string | null;
    ynab_account_id?: string | null;
    import_id?: string | null;
    is_primary: boolean;
    correlated_with?: string | null;
    fee_applied: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT
// ═══════════════════════════════════════════════════════════════════════════

// Get Supabase credentials from environment
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

/**
 * Checks if Supabase is configured for SMS context storage.
 */
export function isSupabaseConfigured(): boolean {
    return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Makes a request to Supabase REST API.
 */
async function supabaseRequest<T>(
    endpoint: string,
    options: {
        method?: string;
        body?: unknown;
        headers?: Record<string, string>;
    } = {},
): Promise<T> {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Supabase not configured");
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
        method: options.method || "GET",
        headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=representation",
            ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Supabase error: ${response.status} - ${error}`);
    }

    // Handle empty responses (e.g., from DELETE)
    const text = await response.text();
    if (!text) return [] as T;

    return JSON.parse(text) as T;
}

// ═══════════════════════════════════════════════════════════════════════════
// SMS CONTEXT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stores SMS context for potential correlation with follow-up messages.
 *
 * @param context - SMS context to store
 * @returns The created record
 */
export async function storeSmsContext(
    context: Omit<SmsContextRecord, "id">,
): Promise<SmsContextRecord> {
    const result = await supabaseRequest<SmsContextRecord[]>("sms_context", {
        method: "POST",
        body: context,
    });
    return result[0];
}

/**
 * Finds recent primary transactions from the same sender that haven't had
 * their transfer-type fee applied yet.
 *
 * Used to correlate follow-up SMS (like ABSA SMS2) with the original transaction.
 *
 * @param sender - SMS sender (e.g., "Absa")
 * @param withinMinutes - How far back to look (default 5 minutes)
 * @returns Matching SMS context records
 */
export async function findRecentPrimaryTransactions(
    sender: string,
    withinMinutes: number = 5,
): Promise<SmsContextRecord[]> {
    const cutoffTime = new Date(Date.now() - withinMinutes * 60 * 1000)
        .toISOString();

    // Query for recent primary transactions from same sender without fee applied
    const endpoint = `sms_context?sender=ilike.${
        encodeURIComponent(sender)
    }&is_primary=eq.true&fee_applied=eq.false&received_at=gte.${cutoffTime}&order=received_at.desc`;

    return await supabaseRequest<SmsContextRecord[]>(endpoint);
}

/**
 * Finds a recent primary transaction with matching amount.
 * Used when follow-up SMS doesn't repeat the amount.
 *
 * @param sender - SMS sender
 * @param amount - Transaction amount to match (optional)
 * @param withinMinutes - How far back to look
 * @returns Matching record or null
 */
export async function findMatchingTransaction(
    sender: string,
    amount?: number | null,
    withinMinutes: number = 5,
): Promise<SmsContextRecord | null> {
    const records = await findRecentPrimaryTransactions(sender, withinMinutes);

    if (records.length === 0) return null;

    // If amount provided, try to match by amount
    if (amount !== null && amount !== undefined) {
        const match = records.find((r) => r.amount === amount);
        if (match) return match;
    }

    // Otherwise return the most recent one
    return records[0];
}

/**
 * Updates an SMS context record to mark that a fee was applied.
 *
 * @param id - Record ID to update
 */
export async function markFeeApplied(id: string): Promise<void> {
    await supabaseRequest(`sms_context?id=eq.${id}`, {
        method: "PATCH",
        body: { fee_applied: true },
    });
}

/**
 * Links a follow-up SMS to a primary transaction.
 *
 * @param followUpId - Follow-up SMS record ID
 * @param primaryId - Primary transaction record ID
 */
export async function linkToCorrelation(
    followUpId: string,
    primaryId: string,
): Promise<void> {
    await supabaseRequest(`sms_context?id=eq.${followUpId}`, {
        method: "PATCH",
        body: { correlated_with: primaryId },
    });
}

/**
 * Cleans up old SMS context records (older than 1 hour).
 * Call this periodically to keep the table small.
 */
export async function cleanupOldRecords(): Promise<void> {
    const cutoffTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await supabaseRequest(`sms_context?created_at=lt.${cutoffTime}`, {
        method: "DELETE",
    });
}
