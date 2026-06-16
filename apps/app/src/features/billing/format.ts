export function creditsFromMillicredits(value: string): string {
  const raw = BigInt(value);
  const sign = raw < 0n ? "-" : "";
  const absolute = raw < 0n ? -raw : raw;
  const whole = absolute / 1000n;
  const fraction = absolute % 1000n;
  if (fraction === 0n) return `${sign}${whole.toLocaleString()}`;
  return `${sign}${whole.toLocaleString()}.${fraction.toString().padStart(3, "0").replace(/0+$/, "")}`;
}
