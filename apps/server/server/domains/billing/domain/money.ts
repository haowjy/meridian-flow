/** Canonical USD, Stripe cents, and millicredit conversion rules. */
import { BillingRequestError } from "./errors.js";

export const MILLICREDITS_PER_USD = 100_000n;
const MILLICREDITS_PER_STRIPE_CENT = 1_000n;

export function millicreditsToUsd(value: string | bigint): string {
  const raw = typeof value === "bigint" ? value : BigInt(value);
  const sign = raw < 0n ? "-" : "";
  const absolute = raw < 0n ? -raw : raw;
  const whole = absolute / 100_000n;
  const fraction = absolute % 100_000n;
  if (fraction === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${fraction.toString().padStart(5, "0").replace(/0+$/, "")}`;
}

export function usdToMillicredits(usd: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(usd)) {
    throw new BillingRequestError(
      "amountUsd must be a positive USD decimal with at most 2 decimal places",
    );
  }
  const [whole, fraction = ""] = usd.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n) throw new BillingRequestError("amountUsd must be positive");
  return cents * MILLICREDITS_PER_STRIPE_CENT;
}

export function millicreditsToStripeCents(value: string | bigint): number {
  const millicredits = typeof value === "bigint" ? value : BigInt(value);
  if (millicredits <= 0n) throw new Error("grantMillicredits must be positive");
  const cents = millicredits / MILLICREDITS_PER_STRIPE_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("grantMillicredits is too large for a Stripe unit_amount");
  }
  return Number(cents);
}
