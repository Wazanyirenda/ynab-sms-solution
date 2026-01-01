/**
 * FEE CALCULATOR — Calculate transaction fees for mobile money & banks
 *
 * Fees vary by provider and transfer type. Configure your fee schedules below.
 *
 * Fee data sources:
 * - https://liquify-zambia.com/help/mobile_money_charges.html
 * - https://077.airtel.co.zm/assets/pdf/AIRTEL-Tariff-Guide-Poster-A1.pdf
 * - https://www.absa.co.zm/personal/ultimate-plus-account/
 *
 * Note: Fees change over time. Verify against your actual transactions.
 */

// Fee category from environment variable
const FEE_CATEGORY_NAME: string | null = Deno.env.get("FEE_CATEGORY_NAME") ||
    null;

// Types
interface FeeTier {
    min: number;
    max: number;
    fee: number;
}

interface FeeSchedule {
    tiers: FeeTier[];
    payee: string;
    category: string | null;
}

export type TransferType =
    | "same_network"
    | "cross_network"
    | "to_bank"
    | "from_bank"
    | "to_mobile"
    | "withdrawal"
    | "bill_payment"
    | "airtime"
    | "pos"
    | "unknown";

export type Provider =
    | "airtel"
    | "mtn"
    | "zamtel"
    | "absa"
    | "stanchart"
    | "unknown";

export interface FeeResult {
    fee: number | null;
    payee: string | null;
    category: string | null;
    configured: boolean;
}

// Fee schedules by provider and transfer type
const FEE_CONFIG: Record<Provider, Partial<Record<TransferType, FeeSchedule>>> =
    {
        // AIRTEL MONEY
        airtel: {
            same_network: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    { min: 0, max: 150, fee: 0.58 },
                    { min: 150, max: 300, fee: 1.1 },
                    { min: 300, max: 500, fee: 1.2 },
                    { min: 500, max: 1000, fee: 2.0 },
                    { min: 1000, max: 3000, fee: 3.6 },
                    { min: 3000, max: 5000, fee: 5.0 },
                    { min: 5000, max: 10000, fee: 7.0 },
                ],
            },
            cross_network: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
            to_bank: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
            withdrawal: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
            airtime: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
            bill_payment: {
                payee: "Airtel",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
        },

        // MTN MONEY
        mtn: {
            same_network: {
                payee: "MTN",
                category: FEE_CATEGORY_NAME,
                tiers: [
                    { min: 0, max: 150, fee: 0.58 },
                    { min: 150, max: 300, fee: 1.1 },
                    { min: 300, max: 500, fee: 1.2 },
                    { min: 500, max: 1000, fee: 2.0 },
                    { min: 1000, max: 3000, fee: 3.8 },
                    { min: 3000, max: 5000, fee: 5.0 },
                    { min: 5000, max: 10000, fee: 7.0 },
                ],
            },
        },

        // ZAMTEL MONEY
        zamtel: {
            same_network: {
                payee: "Zamtel",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
        },

        // ABSA BANK (Ultimate Plus Account - adjust for your account type)
        absa: {
            to_mobile: {
                payee: "Absa",
                category: FEE_CATEGORY_NAME,
                tiers: [{ min: 0, max: 1000000, fee: 10.0 }],
            },
            withdrawal: {
                payee: "Absa",
                category: FEE_CATEGORY_NAME,
                tiers: [{ min: 0, max: 1000000, fee: 20.0 }],
            },
            bill_payment: {
                payee: "Absa",
                category: FEE_CATEGORY_NAME,
                tiers: [],
            },
        },

        // STANDARD CHARTERED
        stanchart: {},

        // Unknown provider
        unknown: {},
    };

// SMS notification fees (per SMS alert)
interface SmsNotificationFee {
    fee: number;
    payee: string;
    category: string | null;
}

const SMS_NOTIFICATION_FEES: Partial<Record<Provider, SmsNotificationFee>> = {
    absa: { fee: 0.5, payee: "Absa", category: FEE_CATEGORY_NAME },
};

/**
 * Calculates the transaction fee for a given transfer.
 */
export function calculateFee(
    provider: Provider,
    transferType: TransferType,
    amount: number,
): FeeResult {
    const schedule = FEE_CONFIG[provider]?.[transferType];

    if (!schedule) {
        return { fee: null, payee: null, category: null, configured: false };
    }

    if (schedule.tiers.length === 0) {
        return {
            fee: 0,
            payee: schedule.payee,
            category: schedule.category,
            configured: true,
        };
    }

    const tier = schedule.tiers.find((t) => amount > t.min && amount <= t.max);

    if (!tier) {
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
 */
export function senderToProvider(sender: string): Provider {
    const s = sender.toLowerCase();
    if (s.includes("airtel")) return "airtel";
    if (s.includes("mtn")) return "mtn";
    if (s.includes("zamtel") || s.includes("zampay")) return "zamtel";
    if (s.includes("absa")) return "absa";
    if (s.includes("stanchart") || s.includes("standard chartered")) {
        return "stanchart";
    }
    return "unknown";
}

/**
 * Checks if fees are configured for a provider/transfer type.
 */
export function hasFeesConfigured(
    provider: Provider,
    transferType: TransferType,
): boolean {
    return FEE_CONFIG[provider]?.[transferType] !== undefined;
}

/**
 * Gets the SMS notification fee for a provider.
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
