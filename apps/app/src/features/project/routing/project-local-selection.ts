/** Resolves browser-local Untitled history without turning missing ownership into a default. */
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
    !pointer.documentId ||
    !input.workId
  )
    return { kind: "unavailable" } as const;
  if (!input.hydrated) return { kind: "loading" } as const;
  const owner = resolveDeskRoute({
    tabs: input.tabs,
    selectedDocumentId: pointer.documentId,
    locator: { scheme: "scratch", path: "", workId: input.workId },
  });
  return owner.kind === "unowned"
    ? ({ kind: "unavailable" } as const)
    : ({ kind: "resolved", documentId: pointer.documentId, owner } as const);
}
