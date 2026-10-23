/** Resolves browser-local resource history without turning missing ownership into a default. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { useRef } from "react";
import { type ContextTab, editorTabsForWork, isDraftOnly } from "@/client/stores";
import { resolveWorkspaceRoute } from "../context/context-route-workspace-owner";
import type { ProjectAddress } from "./project-address";

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
    pointer.version !== 3 ||
    !("accountId" in pointer) ||
    pointer.accountId !== input.accountId ||
    !("projectId" in pointer) ||
    pointer.projectId !== input.projectId ||
    !("documentId" in pointer) ||
    typeof pointer.documentId !== "string" ||
    !pointer.documentId ||
    ("resourceHandle" in pointer &&
      (typeof pointer.resourceHandle !== "string" || !pointer.resourceHandle))
  )
    return { kind: "absent" } as const;
  if (!input.hydrated) return { kind: "loading" } as const;
  const tab = input.tabs.find((candidate) => candidate.documentId === pointer.documentId);
  if (!tab) {
    if (
      "resourceHandle" in pointer &&
      input.tabs.some((candidate) => candidate.resourceHandle === pointer.resourceHandle)
    )
      return { kind: "absent" } as const;
    return { kind: "identity", documentId: pointer.documentId } as const;
  }
  if ("resourceHandle" in pointer && tab.resourceHandle !== pointer.resourceHandle)
    return { kind: "absent" } as const;
  if (!input.workId) return { kind: "identity", documentId: pointer.documentId } as const;
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
  /** The Editor being entered: its row id, or null while unresolved. */
  workId: string | null;
}): ContextTab | null {
  const eligible = editorTabsForWork(input.tabs, input.workId);
  const selected = eligible.find((tab) => tab.documentId === input.selectedDocumentId);
  if (selected) return selected;
  for (const route of input.recentRoutes) {
    const tab = eligible.find((tab) => tab.documentId === route.documentId && !isDraftOnly(tab));
    if (tab) return tab;
  }
  return null;
}

/** The Editor's URL slot remains its address while another container presents. */
export function useEditorContainerAddress(input: {
  active: boolean;
  accountId: string;
  address: ProjectAddress;
  documentId: string | null;
  workId: string | null;
}) {
  const retained = useRef<typeof input | null>(null);
  if (
    retained.current?.accountId !== input.accountId ||
    retained.current?.address.projectId !== input.address.projectId
  )
    retained.current = null;
  if (input.active) retained.current = input;
  return retained.current;
}
