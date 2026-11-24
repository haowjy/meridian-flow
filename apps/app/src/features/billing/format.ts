export function formatUsd(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "$0.00";

  const negative = trimmed.startsWith("-");
  const unsigned = (negative ? trimmed.slice(1) : trimmed).replace(/^\+/, "");
  const [wholeRaw = "0", fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const cents = fracRaw.padEnd(2, "0").slice(0, 2);

  const isZero = whole === "0" && /^0*$/.test(fracRaw);
  if (whole === "0" && cents === "00" && !isZero) {
    return negative ? "-< $0.01" : "< $0.01";
  }

  const wholeFormatted = BigInt(whole).toLocaleString("en-US");
  return `${negative ? "-" : ""}$${wholeFormatted}.${cents}`;
}

export function isPositiveUsd(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) return false;
  return /[1-9]/.test(trimmed);
}
