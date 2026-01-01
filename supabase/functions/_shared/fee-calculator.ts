/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FEE CALCULATOR — Calculate transaction fees for mobile money & banks
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fees vary by provider and transfer type. This module handles:
 * - Fee tier lookups based on amount ranges
 * - Different transfer types (same network, cross-network, to bank, etc.)
 *
 * Fee data sources:
 * - https://liquify-zambia.com/help/mobile_money_charges.html (more accurate)
 * - https://077.airtel.co.zm/assets/pdf/AIRTEL-Tariff-Guide-Poster-A1.pdf
 *
 * NOTE: Fees change over time! Update tiers as needed.
 * Last verified: January 2025 (Airtel same-network tested with K1000 → K2 fee)
 */

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
    category: string; // YNAB category name (e.g., "Bank Transaction & Fees")
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
    | "withdrawal" // Cash out at agent
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
                category: "Bank Transaction & Fees",
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
                category: "Bank Transaction & Fees",
                tiers: [
                    // Placeholder — fees are typically higher than same-network
                    // User will collect SMS samples to verify these rates
                ],
            },

            // Airtel Money → Bank account
            // TODO: Add when fee data is collected
            to_bank: {
                payee: "Airtel",
                category: "Bank Transaction & Fees",
                tiers: [
                    // Placeholder — wallet-to-bank transfer fees
                ],
            },

            // Cash withdrawal at Airtel agent
            // TODO: Add when fee data is collected
            withdrawal: {
                payee: "Airtel",
                category: "Bank Transaction & Fees",
                tiers: [
                    // Placeholder — withdrawal fees
                ],
            },

            // Airtime purchase — usually FREE
            airtime: {
                payee: "Airtel",
                category: "Bank Transaction & Fees",
                tiers: [], // No fee for airtime purchases
            },

            // Bill payments (utilities, merchants)
            // TODO: Add when fee data is collected
            bill_payment: {
                payee: "Airtel",
                category: "Bank Transaction & Fees",
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
                category: "Bank Transaction & Fees",
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
                category: "Bank Transaction & Fees",
                tiers: [
                    // TODO: Add Zamtel fees when documented
                ],
            },
        },

        // ═══════════════════════════════════════════════════════════════════
        // BANK FEES — PLACEHOLDER
        // ═══════════════════════════════════════════════════════════════════
        // Bank fees are often more complex (monthly fees, per-transaction, etc.)
        // Will add as user documents them

        absa: {
            // ABSA bank transfer fees
            // TODO: Add when fee data is collected
        },

        stanchart: {
            // Standard Chartered transfer fees
            // TODO: Add when fee data is collected
        },

        // Unknown provider — no fees applied
        unknown: {},
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
 * // Returns: { fee: 2.0, payee: "Airtel", category: "Bank Transaction & Fees", configured: true }
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
