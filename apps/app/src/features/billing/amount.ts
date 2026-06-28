/**
 * Helpers for the extra-usage amount picker. The server sends USD as decimal
 * strings (`"5.00"`, `"10.00"`) and accepts the chosen amount the same way.
 * This layer normalizes user-facing strings and validates client-side so the
 * Buy button can disable itself with an inline hint before round-tripping.
 *
 * Why not use `Number` everywhere: USD comparisons are at most two decimal
 * places and well under `Number.MAX_SAFE_INTEGER`, so `parseFloat` is safe
 * for the min/max range check. We still preserve the user's typed string so
 * the request body matches what they entered.
 */

export type AmountValidation =
  | { ok: true; amountUsd: string }
  | { ok: false; reason: "empty" | "non-numeric" | "below-min" | "above-max" };

/** Numeric value of a USD decimal string, or `null` if not a valid amount. */
export function parseUsd(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Accept digits with at most one decimal point and up to 2 fractional digits.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Display a preset amount as `$X` (no trailing zeros for whole dollars). */
export function formatPreset(value: string): string {
  const n = parseUsd(value);
  if (n === null) return `$${value}`;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * Display form for an input field — strips a `.00` suffix so the default
 * `"10.00"` shows as `"10"` while preserving non-zero fractions.
 */
export function toInputValue(value: string): string {
  const n = parseUsd(value);
  if (n === null) return value;
  return `${n}`;
}

export function validateAmount(
  input: string,
  bounds: { minUsd: string; maxUsd: string },
): AmountValidation {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  const value = parseUsd(trimmed);
  if (value === null) return { ok: false, reason: "non-numeric" };
  const min = parseUsd(bounds.minUsd);
  const max = parseUsd(bounds.maxUsd);
  if (min !== null && value < min) return { ok: false, reason: "below-min" };
  if (max !== null && value > max) return { ok: false, reason: "above-max" };
  return { ok: true, amountUsd: trimmed };
}

/** True if two USD strings represent the same numeric value. */
export function equalsUsd(a: string, b: string): boolean {
  const na = parseUsd(a);
  const nb = parseUsd(b);
  if (na === null || nb === null) return false;
  return na === nb;
}
