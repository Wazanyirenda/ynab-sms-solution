/**
 * EXTRACTORS — Deterministic data extraction from SMS using regex.
 *
 * These functions extract data that can be reliably parsed without AI.
 * This improves accuracy, speed, and reduces AI token costs.
 */

// ============================================================================
// AMOUNT EXTRACTION
// ============================================================================

/**
 * Extracts the transaction amount from SMS text.
 * Looks for patterns like "ZMW 100.00", "ZMW 1,234.56", "K100"
 *
 * @returns The amount as a number, or null if not found
 */
export function extractAmount(text: string): number | null {
    // Pattern matches: ZMW 100.00, ZMW 1,234.56, K100, etc.
    const patterns = [
        /ZMW\s*([\d,]+\.?\d*)/i,
        /K\s*([\d,]+\.?\d*)/i,
        /amount[:\s]*([\d,]+\.?\d*)/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const amount = parseFloat(match[1].replace(/,/g, ""));
            if (!isNaN(amount) && amount > 0) return amount;
        }
    }

    return null;
}

// ============================================================================
// BALANCE EXTRACTION
// ============================================================================

/**
 * Extracts the remaining balance from SMS text.
 * Looks for patterns like "Balance: ZMW 500.00", "Your bal is ZMW 123.45"
 *
 * @returns The balance as a number, or null if not found
 */
export function extractBalance(text: string): number | null {
    const patterns = [
        // "Balance:ZMW 7790.00" or "Balance: ZMW 7790.00"
        /[Bb]alance[:\s]*(?:ZMW\s*)?([\d,]+\.?\d*)/,
        // "available balance is 5,161.02"
        /available balance[:\s]*(?:is\s*)?(?:ZMW\s*)?([\d,]+\.?\d*)/i,
        // "Your bal is ZMW 500.00"
        /your bal[:\s]*(?:is\s*)?(?:ZMW\s*)?([\d,]+\.?\d*)/i,
        // "Bal: ZMW 500.00" or "Bal:ZMW500"
        /\bbal[:\s]*(?:ZMW\s*)?([\d,]+\.?\d*)/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const balance = parseFloat(match[1].replace(/,/g, ""));
            if (!isNaN(balance)) return balance;
        }
    }

    return null;
}

// ============================================================================
// TIME EXTRACTION
// ============================================================================

/**
 * Extracts transaction time from SMS text.
 * Looks for patterns like "14:30", "at 14:30", "as at 09/01/2026 01:40"
 *
 * @returns Time in HH:MM format, or fallback if not found
 */
export function extractTime(text: string, fallback: string): string {
    // Look for time patterns (HH:MM)
    const patterns = [
        /\b(\d{1,2}:\d{2})\b/, // Generic time like "14:30"
        /at\s+(\d{1,2}:\d{2})/i, // "at 14:30"
        /as at[^]*?(\d{1,2}:\d{2})/i, // "as at 09/01/2026 01:40"
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            // Validate it looks like a time (0-23 hours, 0-59 minutes)
            const [hours, minutes] = match[1].split(":").map(Number);
            if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
                return match[1].padStart(5, "0"); // Ensure HH:MM format
            }
        }
    }

    return fallback;
}

// ============================================================================
// TRANSACTION REFERENCE EXTRACTION
// ============================================================================

/**
 * Extracts transaction reference/ID from SMS text.
 * Looks for patterns like "TID: PP260103.1322.Y60312", "Ref: ABC123"
 *
 * @returns The reference ID string, or null if not found
 */
export function extractTransactionRef(text: string): string | null {
    const patterns = [
        /TID[:\s]*([A-Z0-9.]+)/i, // "TID: PP260103.1322.Y60312"
        /Ref[:\s]*([A-Z0-9]+)/i, // "Ref: ABC123"
        /Txn\s*ID[:\s]*([A-Z0-9]+)/i, // "Txn ID: 12345"
        /Reference[:\s]*([A-Z0-9]+)/i, // "Reference: XYZ789"
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1].length >= 4) {
            return match[1];
        }
    }

    return null;
}

// ============================================================================
// PHONE NUMBER & NETWORK DETECTION
// ============================================================================

export type MobileNetwork = "airtel" | "mtn" | "zamtel" | "unknown";

export interface PhoneInfo {
    phone: string;
    network: MobileNetwork;
}

// Zambian mobile network prefixes (without leading 0)
const NETWORK_PREFIXES: Record<string, MobileNetwork> = {
    "97": "airtel",
    "77": "airtel",
    "96": "mtn",
    "76": "mtn",
    "95": "zamtel",
    "75": "zamtel",
};

/**
 * Extracts phone number from SMS and determines the mobile network.
 * Looks for Zambian mobile numbers (9 digits starting with 9x or 7x).
 *
 * @returns Phone info with network, or null if no phone found
 */
export function extractPhoneAndNetwork(text: string): PhoneInfo | null {
    // Match Zambian mobile numbers: 0971234567, 971234567, +260971234567
    const patterns = [
        /\b0?([97][567]\d{7})\b/, // 0971234567 or 971234567
        /\+260([97][567]\d{7})\b/, // +260971234567
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const phone = match[1];
            const prefix = phone.slice(0, 2);
            const network = NETWORK_PREFIXES[prefix] || "unknown";
            return { phone, network };
        }
    }

    return null;
}

/**
 * Determines if sender and recipient are on the same network.
 *
 * @returns "same_network", "cross_network", or null if can't determine
 */
export function determineNetworkTransfer(
    senderNetwork: MobileNetwork,
    recipientNetwork: MobileNetwork,
): "same_network" | "cross_network" | null {
    if (senderNetwork === "unknown" || recipientNetwork === "unknown") {
        return null;
    }
    return senderNetwork === recipientNetwork
        ? "same_network"
        : "cross_network";
}

// ============================================================================
// DETERMINISTIC TRANSFER TYPE DETECTION
// ============================================================================

export type TransferType =
    | "same_network"
    | "cross_network"
    | "to_bank"
    | "to_mobile"
    | "withdrawal"
    | "airtime"
    | "bill_payment"
    | "pos"
    | "unknown";

/**
 * Detects transfer type from SMS text using deterministic patterns.
 * Returns null if type cannot be determined (let AI decide).
 */
export function detectTransferType(
    text: string,
    senderNetwork: MobileNetwork,
): TransferType | null {
    const lower = text.toLowerCase();

    // POS transaction (highest priority - very clear pattern)
    if (lower.includes("at pos") || / pos /i.test(text)) {
        return "pos";
    }

    // Absa ATM withdrawal (specific pattern)
    if (lower.includes("debit card transaction")) {
        return "withdrawal";
    }

    // Airtime/data purchase
    if (
        lower.includes("top-up") ||
        lower.includes("topup") ||
        lower.includes("airtime") ||
        lower.includes("data bundle")
    ) {
        return "airtime";
    }

    // Bill/till payment
    if (lower.includes("till number") || lower.includes("till no")) {
        return "bill_payment";
    }

    // Agent withdrawal (mobile money)
    if (
        lower.includes("agent") &&
        (lower.includes("withdraw") || lower.includes("cash out"))
    ) {
        return "withdrawal";
    }

    // Check for phone number to determine same/cross network
    const phoneInfo = extractPhoneAndNetwork(text);
    if (phoneInfo && senderNetwork !== "unknown") {
        const networkType = determineNetworkTransfer(
            senderNetwork,
            phoneInfo.network,
        );
        if (networkType) return networkType;
    }

    // Can't determine - let AI decide
    return null;
}

// ============================================================================
// MEMO FORMATTING
// ============================================================================

/**
 * Formats the transaction memo consistently.
 * Format: "[Action] [Payee] | [HH:MM] | Bal: [Balance]"
 */
export function formatMemo(
    action: string,
    payee: string | null,
    time: string,
    balance: number | null,
): string {
    const parts: string[] = [];

    // Action + Payee
    if (payee) {
        parts.push(`${action} ${payee}`);
    } else {
        parts.push(action);
    }

    // Time
    parts.push(time);

    // Balance (if available)
    if (balance !== null) {
        parts.push(`Bal: ${balance.toFixed(2)}`);
    }

    return parts.join(" | ");
}

// ============================================================================
// PRE-EXTRACTION (Run before AI)
// ============================================================================

export interface PreExtractedData {
    amount: number | null;
    balance: number | null;
    time: string;
    transactionRef: string | null;
    phoneInfo: PhoneInfo | null;
    transferType: TransferType | null;
}

/**
 * Extracts all deterministic data from SMS before sending to AI.
 * This reduces AI workload and improves accuracy.
 */
export function preExtract(
    text: string,
    senderNetwork: MobileNetwork,
    fallbackTime: string,
): PreExtractedData {
    const phoneInfo = extractPhoneAndNetwork(text);

    return {
        amount: extractAmount(text),
        balance: extractBalance(text),
        time: extractTime(text, fallbackTime),
        transactionRef: extractTransactionRef(text),
        phoneInfo,
        transferType: detectTransferType(text, senderNetwork),
    };
}
