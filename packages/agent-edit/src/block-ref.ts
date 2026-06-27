declare const __block: unique symbol;

/**
 * Opaque live block reference for resolver → apply payloads.
 *
 * This is a branded view of the model adapter's native block object, not a wrapper.
 * Object identity must be preserved for same-turn grouping and tombstone checks.
 */
export type BlockRef = { readonly [__block]: true };
