/** Sizes as a writer reads them: "2.4 GB". */
import { i18n } from "@lingui/core";

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${i18n.number(Number(value.toFixed(digits)), { maximumFractionDigits: digits })} ${units[unit]}`;
}
