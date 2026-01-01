/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FEE CALCULATOR — Calculate transaction fees for mobile money & banks
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fees vary by provider and transfer type. This module handles:
 * - Fee tier lookups based on amount ranges
 * - Different transfer types (same network, cross-network, to bank, etc.)
 * - SMS notification fees (charged per SMS by some banks)
 *
 * Fee data sources:
 * - https://liquify-zambia.com/help/mobile_money_charges.html (more accurate)
 * - https://077.airtel.co.zm/assets/pdf/AIRTEL-Tariff-Guide-Poster-A1.pdf
 * - https://www.absa.co.zm/personal/ultimate-plus-account/ (ABSA fees)
 *
 * CUSTOMIZATION:
 * - Set FEE_CATEGORY_NAME env var to match your YNAB category for fees
 * - ABSA fees below are for Ultimate Plus account — adjust for your account type
 * - Fees change over time! Update tiers as needed.
 *
 * Last verified: January 2025 (Airtel same-network tested with K1000 → K2 fee)
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The YNAB category name for fee transactions.
 * Set via FEE_CATEGORY_NAME environment variable.
 * If not set, fees will be created without a category (user assigns manually).
 *
 * Example: FEE_CATEGORY_NAME="🏦 Bank / Transaction Fees"
 */
const FEE_CATEGORY_NAME: string | null = Deno.env.get("FEE_CATEGORY_NAME") ||
    null;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single fee tier with min/max amount range.
 * Amount must be > min AND <= max to match this tier.
 */
interface FeeTier {
    min: number; // Minimum amount (exclusive, except first tier where min=0)
    max: number; // Maximum amount (inclusive)
    fee: number; // Fee charged for this tier in ZMW
}

/**
 * Fee schedule for a specific transfer type.
 * Contains the tiers and metadata for creating the fee transaction.
 */
interface FeeSchedule {
    tiers: FeeTier[];
    payee: string; // YNAB payee name for the fee (e.g., "Airtel")
    category: string | null; // YNAB category name, or null if not configured
}

/**
 * Transfer types we support for fee calculation.
 * The AI determines this from the SMS content.
 */
export type TransferType =
    | "same_network" // Airtel → Airtel, MTN → MTN, etc.
    | "cross_network" // Airtel → MTN, MTN → Zamtel, etc.
    | "to_bank" // Mobile money → Bank account
    | "from_bank" // Bank → Mobile money (usually no fee on mobile side)
    | "to_mobile" // Bank → Mobile money (fee on bank side)
    | "withdrawal" // Cash out at agent or ATM
    | "bill_payment" // Pay utility bills, merchants
    | "airtime" // Airtime/data purchase (usually free)
    | "unknown"; // Couldn't determine type — no fee applied

/**
 * Provider/network identifiers.
 * Used to look up the correct fee schedule.
 */
export type Provider =
    | "airtel"
    | "mtn"
    | "zamtel"
    | "absa"
    | "stanchart"
    | "unknown";

// ═══════════════════════════════════════════════════════════════════════════
// FEE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fee schedules organized by provider and transfer type.
 *
 * Data source: https://liquify-zambia.com/help/mobile_money_charges.html
 * This source is more accurate than official PDFs based on real-world testing.
 *
 * User verified: K1000 Airtel→Airtel = K2 fee ✓
 */
const FEE_CONFIG: Record<Provider, Partial<Record<TransferType, FeeSchedule>>> =
    {
        // ═══════════════════════════════════════════════════════════════════
        // AIRTEL MONEY FEES
        // ═══════════════════════════════════════════════════════════════════
        airtel: {
            // Airtel Money → Airtel Money (same network, person-to-person)
            // Source: https://liquify-zambia.com/help/mobile_money_charges.html
            same_network: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    { min: 0, max: 150, fee: 0.58 },
                    { min: 150, max: 300, fee: 1.1 },
                    { min: 300, max: 500, fee: 1.2 },
                    { min: 500, max: 1000, fee: 2.0 }, // Verified: K1000 = K2 fee
                    { min: 1000, max: 3000, fee: 3.6 },
                    { min: 3000, max: 5000, fee: 5.0 },
                    { min: 5000, max: 10000, fee: 7.0 },
                ],
            },

            // Airtel Money → Other networks (MTN, Zamtel)
            // TODO: Add when fee data is collected
            cross_network: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    // Placeholder — fees are typically higher than same-network
                    // User will collect SMS samples to verify these rates
                ],
            },

            // Airtel Money → Bank account
            // TODO: Add when fee data is collected
            to_bank: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    // Placeholder — wallet-to-bank transfer fees
                ],
            },

            // Cash withdrawal at Airtel agent
            // TODO: Add when fee data is collected
            withdrawal: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    // Placeholder — withdrawal fees
                ],
            },

            // Airtime purchase — usually FREE
            airtime: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [], // No fee for airtime purchases
            },

            // Bill payments (utilities, merchants)
            // TODO: Add when fee data is collected
            bill_payment: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    // Placeholder — bill payment fees
                ],
            },
        },

        // ═══════════════════════════════════════════════════════════════════
        // MTN MONEY FEES — PLACEHOLDER
        // ═══════════════════════════════════════════════════════════════════
        mtn: {
            same_network: {
                payee: "MTN",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    // Source: https://liquify-zambia.com/help/mobile_money_charges.html
                    // TODO: Verify with real transactions
                    { min: 0, max: 150, fee: 0.58 },
                    { min: 150, max: 300, fee: 1.1 },
                    { min: 300, max: 500, fee: 1.2 },
                    { min: 500, max: 1000, fee: 2.0 },
                    { min: 1000, max: 3000, fee: 3.8 },
                    { min: 3000, max: 5000, fee: 5.0 },
                    { min: 5000, max: 10000, fee: 7.0 },
                ],
            },
            // Other MTN transfer types — add as needed
        },

        // ═══════════════════════════════════════════════════════════════════
        // ZAMTEL MONEY (ZAMPAY) FEES — PLACEHOLDER
        // ═══════════════════════════════════════════════════════════════════
        zamtel: {
            same_network: {
                payee: "Zamtel",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    // TODO: Add Zamtel fees when documented
                ],
            },
        },

        // ═══════════════════════════════════════════════════════════════════
        // ABSA BANK FEES (Ultimate Plus Account)
        // ═══════════════════════════════════════════════════════════════════
        // Source: https://www.absa.co.zm/personal/ultimate-plus-account/
        // Note: ABSA uses FLAT fees (same regardless of amount)

        absa: {
            // ABSA → Mobile Money (flat K10 fee)
            to_mobile: {
                payee: "Absa",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    { min: 0, max: 1000000, fee: 10.0 }, // Flat fee for any amount
                ],
            },

            // ATM withdrawal (flat K20 fee for both Absa and non-Absa ATMs)
            withdrawal: {
                payee: "Absa",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    { min: 0, max: 1000000, fee: 20.0 }, // Flat fee for any amount
                ],
            },

            // Bill payments — TODO: Add when fee data is collected
            bill_payment: {
                payee: "Absa",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
        },

        // ═══════════════════════════════════════════════════════════════════
        // STANDARD CHARTERED FEES — PLACEHOLDER
        // ═══════════════════════════════════════════════════════════════════
        stanchart: {
            // Standard Chartered transfer fees
            // TODO: Add when fee data is collected
        },

        // Unknown provider — no fees applied
        unknown: {},
    };

// ═══════════════════════════════════════════════════════════════════════════
// SMS NOTIFICATION FEES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SMS notification fees charged by banks for sending transaction alerts.
 * These apply to EVERY SMS received from the provider, regardless of transaction type.
 *
 * Note: This is separate from transaction fees — it's the cost of receiving the SMS itself.
 */
interface SmsNotificationFee {
    fee: number; // Fee per SMS in ZMW
    payee: string; // YNAB payee name
    category: string | null; // YNAB category name, or null if not configured
}

const SMS_NOTIFICATION_FEES: Partial<Record<Provider, SmsNotificationFee>> = {
    // ABSA charges K0.50 per SMS notification (if enabled on account)
    // Source: https://www.absa.co.zm/personal/ultimate-plus-account/
    absa: {
        fee: 0.5,
        payee: "Absa",
        category: FEE_CATEGORY_NAME,
    },
    // Other banks can be added here if they charge SMS fees
    // Most mobile money providers don't charge for SMS alerts
};

// ═══════════════════════════════════════════════════════════════════════════
// FEE CALCULATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of a fee calculation.
 */
export interface FeeResult {
    fee: number | null; // Fee amount in ZMW, or null if no fee / not configured
    payee: string | null; // Payee name for the fee transaction
    category: string | null; // Category name for the fee transaction
    configured: boolean; // Whether fees are configured for this provider/type
}

/**
 * Calculates the transaction fee for a given transfer.
 *
 * @param provider - The mobile money provider or bank (e.g., "airtel")
 * @param transferType - Type of transfer (e.g., "same_network")
 * @param amount - Transaction amount in ZMW
 * @returns Fee details or null values if not configured
 *
 * @example
 * // Airtel to Airtel transfer of K1000
 * const result = calculateFee("airtel", "same_network", 1000);
 * // Returns: { fee: 2.0, payee: "Airtel", category: FEE_CATEGORY_NAME, configured: true }
 */
export function calculateFee(
    provider: Provider,
    transferType: TransferType,
    amount: number,
): FeeResult {
    // Get the fee schedule for this provider + transfer type
    const schedule = FEE_CONFIG[provider]?.[transferType];

    // If no schedule exists, fees aren't configured for this combination
    if (!schedule) {
        return { fee: null, payee: null, category: null, configured: false };
    }

    // If schedule exists but has no tiers, it means this transfer type is FREE
    if (schedule.tiers.length === 0) {
        return {
            fee: 0,
            payee: schedule.payee,
            category: schedule.category,
            configured: true,
        };
    }

    // Find the matching tier for this amount
    // Amount must be > min AND <= max
    const tier = schedule.tiers.find((t) => amount > t.min && amount <= t.max);

    // If amount is outside all defined tiers, we can't calculate fee
    if (!tier) {
        console.warn(
            `Amount K${amount} outside configured tiers for ${provider}/${transferType}`,
        );
        return {
            fee: null,
            payee: schedule.payee,
            category: schedule.category,
            configured: true,
        };
    }

    return {
        fee: tier.fee,
        payee: schedule.payee,
        category: schedule.category,
        configured: true,
    };
}

/**
 * Maps SMS sender name to a provider identifier.
 * Used to determine which fee schedule to use.
 *
 * @param sender - SMS sender name (e.g., "AirtelMoney", "MTN", "Absa")
 * @returns Provider identifier
 */
export function senderToProvider(sender: string): Provider {
    const s = sender.toLowerCase();

    // Mobile money providers
    if (s.includes("airtel")) return "airtel";
    if (s.includes("mtn")) return "mtn";
    if (s.includes("zamtel") || s.includes("zampay")) return "zamtel";

    // Banks
    if (s.includes("absa")) return "absa";
    if (s.includes("stanchart") || s.includes("standard chartered")) {
        return "stanchart";
    }

    return "unknown";
}

/**
 * Checks if fees are configured for a provider/transfer type combination.
 * Useful for logging and debugging.
 *
 * @param provider - Provider identifier
 * @param transferType - Transfer type
 * @returns true if fees are configured (even if they're zero)
 */
export function hasFeesConfigured(
    provider: Provider,
    transferType: TransferType,
): boolean {
    return FEE_CONFIG[provider]?.[transferType] !== undefined;
}

/**
 * Gets the SMS notification fee for a provider.
 * This is charged per SMS received, regardless of transaction type.
 *
 * @param provider - Provider identifier (e.g., "absa")
 * @returns Fee details or null if provider doesn't charge SMS fees
 *
 * @example
 * // ABSA charges K0.50 per SMS
 * const result = getSmsNotificationFee("absa");
 * // Returns: { fee: 0.5, payee: "Absa", category: FEE_CATEGORY_NAME, configured: true }
 */
export function getSmsNotificationFee(provider: Provider): FeeResult {
    const config = SMS_NOTIFICATION_FEES[provider];

    if (!config) {
        return { fee: null, payee: null, category: null, configured: false };
    }

    return {
        fee: config.fee,
        payee: config.payee,
        category: config.category,
        configured: true,
    };
}
