/** Lingui and Agent-catalog stand-ins for the chat turn-actions browser fixture. */
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import type { ReactNode } from "react";

export function t(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce((result, part, index) => result + part + (values[index] ?? ""), "");
}

export function plural(value: number, forms: { one: string; other: string }) {
  return (value === 1 ? forms.one : forms.other).replace("#", String(value));
}

export function Trans({ children }: { children?: ReactNode }) {
  return children;
}

export function useLingui() {
  return { i18n: { locale: "en", _: (message: string) => message } };
}

const general: AgentCatalogItem = {
  selection: { catalogEntryId: "entry-general", definitionRevisionId: "rev-general" },
  slug: "general",
  name: "General",
  description: "",
  model: "mock",
  ownership: "system",
  unavailableReasons: [],
};

export function useAgentCatalog() {
  return { status: "ready", agents: [general], refetch: () => undefined };
}
