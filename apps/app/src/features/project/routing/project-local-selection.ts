/** Resolves browser-local resource history without turning missing ownership into a default. */
import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import { resolveWorkspaceRoute } from "../context/context-route-workspace-owner";

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
    pointer.version !== 2 ||
    !("accountId" in pointer) ||
    pointer.accountId !== input.accountId ||
    !("projectId" in pointer) ||
    pointer.projectId !== input.projectId ||
    !("resourceHandle" in pointer) ||
    typeof pointer.resourceHandle !== "string" ||
    !pointer.resourceHandle
  )
    return { kind: "unavailable" } as const;
  if (!input.hydrated) return { kind: "loading" } as const;
  const tab = input.tabs.find((candidate) => candidate.resourceHandle === pointer.resourceHandle);
  if (!tab) return { kind: "unavailable" } as const;
  const owner = resolveWorkspaceRoute({
    tabs: input.tabs,
    selectedDocumentId: tab.documentId,
    locator: { scheme: "unfiled", path: "", workId: input.workId },
  });
  return owner.kind === "unowned"
    ? ({ kind: "unavailable" } as const)
    : ({ kind: "resolved", documentId: tab.documentId, owner } as const);
}

/** Screen entry may resume an open identity, never reopen a historical path. */
export function selectEditorEntryTab(input: {
  tabs: readonly ContextTab[];
  selectedDocumentId: string | undefined;
  recentRoutes: readonly WorkingSetRoute[];
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
