/** Compact, locale-aware count for the turn info popover (`1.2K`). */
export function compactCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
