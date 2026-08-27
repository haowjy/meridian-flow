/** Minimal Lingui runtime for the production Home-row browser fixture. */
import type { ReactNode } from "react";

export function t(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce((result, part, index) => result + part + (values[index] ?? ""), "");
}

export function Trans({ children }: { children?: ReactNode }) {
  return children;
}

export function useLingui() {
  return { i18n: { locale: "en" } };
}
