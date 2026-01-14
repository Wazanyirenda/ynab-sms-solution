/**
 * PAYEE ALIASES — Maps merchant names from SMS to YNAB payee names.
 *
 * When a payee is extracted from SMS, it's checked against these aliases.
 * If matched, the alias (YNAB payee name) is used instead.
 *
 * Add new aliases here as you discover merchant names in SMS that should
 * map to specific YNAB payees.
 */

// Maps SMS merchant name (lowercase) → YNAB payee name
const PAYEE_ALIASES: Record<string, string> = {
    // Lusaka Stock Exchange broker
    "pnz lusaka securities": "LuSE",
    "pnz lusaka securities atm": "LuSE",
    "lusaka securities": "LuSE",
    // Add more aliases here as needed:
    // "sms merchant name": "YNAB Payee Name",
};

/**
 * Applies payee alias if one exists.
 * Returns the YNAB payee name if matched, otherwise returns original payee.
 *
 * @param payee - The payee name extracted from SMS
 * @returns The aliased payee name, or original if no alias exists
 */
export function applyPayeeAlias(payee: string | null): string | null {
    if (!payee) return null;

    const lower = payee.toLowerCase().trim();
    return PAYEE_ALIASES[lower] || payee;
}

/**
 * Checks if a payee has an alias defined.
 */
export function hasPayeeAlias(payee: string): boolean {
    return payee.toLowerCase().trim() in PAYEE_ALIASES;
}
