export type AmountValidation =
  | { ok: true; amountUsd: string }
  | { ok: false; reason: "empty" | "non-numeric" | "below-min" | "above-max" };

export function parseUsd(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function formatPreset(value: string): string {
  const n = parseUsd(value);
  if (n === null) return `$${value}`;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

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

export function equalsUsd(a: string, b: string): boolean {
  const na = parseUsd(a);
  const nb = parseUsd(b);
  if (na === null || nb === null) return false;
  return na === nb;
}
