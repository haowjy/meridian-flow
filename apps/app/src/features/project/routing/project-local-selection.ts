/** Resolves browser-local Untitled history without turning missing ownership into a default. */
import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { resolveDeskRoute } from "../context/context-route-desk-owner";

export function resolveLocalDocumentSelection(input: {
  pointer: unknown;
  accountId: string;
  projectId: string;
  workId: string | null;
  hydrated: boolean;
  tabs: readonly ContextTab[];
}) {
  if (input.pointer === undefined) return { kind: "absent" } as const;
  const pointer = input.pointer;
  if (
    !pointer ||
    typeof pointer !== "object" ||
    !("version" in pointer) ||
    pointer.version !== 1 ||
    !("accountId" in pointer) ||
    pointer.accountId !== input.accountId ||
    !("projectId" in pointer) ||
    pointer.projectId !== input.projectId ||
    !("documentId" in pointer) ||
    typeof pointer.documentId !== "string" ||
    !pointer.documentId
  )
    return { kind: "unavailable" } as const;
  if (!input.hydrated) return { kind: "loading" } as const;
  const owner = resolveDeskRoute({
    tabs: input.tabs,
    selectedDocumentId: pointer.documentId,
    locator: { scheme: "unfiled", path: "", workId: input.workId },
  });
  return owner.kind === "unowned"
    ? ({ kind: "unavailable" } as const)
    : ({ kind: "resolved", documentId: pointer.documentId, owner } as const);
}

/** Screen entry may resume an open identity, never reopen a historical path. */
export function selectEditorEntryTab(input: {
  tabs: readonly ContextTab[];
  selectedDocumentId: string | undefined;
  recentRoutes: readonly WorkingSetRoute[];
  workId: string | null;
}): ContextTab | null {
  const eligible = input.tabs.filter((tab) =>
    tab.kind === "new" ? true : !isWorkScopedProjectContextScheme(tab.scheme),
  );
  const selected = eligible.find((tab) => tab.documentId === input.selectedDocumentId);
  if (selected) return selected;
  for (const route of input.recentRoutes) {
    const tab = eligible.find((tab) => tab.documentId === route.documentId && !tab.draftOnly);
    if (tab) return tab;
  }
  return null;
}
