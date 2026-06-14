// @ts-nocheck
/**
 * Server-side contract coercion helpers: convert runtime/database values into
 * JSON-natural thread contract strings at repository/orchestrator boundaries.
 *
 * Why independent: Date and bigint values are valid inside the server domain,
 * but must be serialized before crossing into `@meridian/contracts` DTOs.
 */
export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toSeqString(value: bigint | number | string): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
