/**
 * USD presentation for the billing UI. Money already arrives as exact USD
 * decimal strings ("7.35", "0.004", "-0.12") — the server owns the
 * millicredits → USD conversion, so this layer only formats.
 *
 * Sub-cent rule: positive amounts strictly less than $0.01 render `< $0.01`
 * (never "$0.00" — the server is metering a real, billable cost).
 * Otherwise: `$X.XX` for non-negative, `-$X.XX` for negative; thousands
 * separators via `BigInt.toLocaleString`. Fractions are truncated, not
 * rounded — pairs cleanly with the sub-cent rule so a half-cent never
 * silently rounds up into a full cent.
 */
export function formatUsd(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "$0.00";

  const negative = trimmed.startsWith("-");
  const unsigned = (negative ? trimmed.slice(1) : trimmed).replace(/^\+/, "");
  const [wholeRaw = "0", fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const cents = fracRaw.padEnd(2, "0").slice(0, 2);

  const isZero = whole === "0" && /^0*$/.test(fracRaw);
  if (!negative && whole === "0" && cents === "00" && !isZero) {
    // Positive sub-cent amount: real cost the user should still see.
    return "< $0.01";
  }

  const wholeFormatted = BigInt(whole).toLocaleString("en-US");
  return `${negative ? "-" : ""}$${wholeFormatted}.${cents}`;
}

/** True iff the USD string represents a strictly-positive amount. */
export function isPositiveUsd(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) return false;
  return /[1-9]/.test(trimmed);
}
