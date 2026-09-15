/** Preserve original query grammar before TanStack's JSON-friendly parser normalizes it. */
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";

const RAW_SEARCH = "__meridianRawSearch";

export function parseBrowserSearch(raw: string): Record<string, unknown> {
  return { ...defaultParseSearch(raw), [RAW_SEARCH]: raw };
}

export function stringifyBrowserSearch(search: Record<string, unknown>): string {
  const { [RAW_SEARCH]: _raw, ...values } = search;
  return defaultStringifySearch(values);
}

export function originalBrowserSearch(search: Record<string, unknown>): string {
  const raw = search[RAW_SEARCH];
  return typeof raw === "string" ? raw : stringifyBrowserSearch(search);
}
