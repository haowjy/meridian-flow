/**
 * Binds edit grants to a write call (file-access §5): every write seam the
 * call reaches locks the grants' Works with its own, in id order, and
 * confirms them inside its transaction before any advisory lock.
 */
import { mergeOwnerLocks } from "../../shared/draft-owner.js";
import { type EditConfirmation, runWithEditConfirmation } from "../../shared/edit-confirmation.js";
import { TreeOwnersMoved, untilOwnersHold } from "../../shared/tree-owners.js";

import {
  type FileAccessDenied,
  type FileFacts,
  type FileGrant,
  type FileTarget,
  grantOwnerLocks,
  isFileAccessDenied,
} from "./domain/types.js";
import type { FileAccess } from "./file-access.js";

/** A seam refused a grant under its locks; the write didn't happen. */
export class FileEditRefusedError extends Error {
  constructor(readonly refused: readonly FileAccessDenied[]) {
    super(`File edit refused: ${refused.map((denial) => denial.reason).join(", ")}`);
    this.name = "FileEditRefusedError";
  }
}

/**
 * Runs `operation` with these grants bound. Returns the refusal a seam threw,
 * even when the write path caught the error and turned it into an outcome. `alsoLock` names
 * more owners the seam locks with the grants': those of a source the write changes outside
 * the grants' targets.
 *
 * A document's owner can move between the facts the grants were minted from and the seam's
 * locks. The seam then throws `TreeOwnersMoved` naming the owners the locks missed, and the
 * operation runs again from its transaction's start with them locked (`untilOwnersHold`).
 */
export function runWithEditGrants<T>(
  access: Pick<FileAccess, "authorize" | "confirmEdit">,
  grants: readonly FileGrant<"edit" | "command">[],
  operation: () => Promise<T>,
  alsoLock?: { works: readonly string[]; lineages: readonly string[] },
): Promise<{ ok: true; value: T } | { ok: false; refusal: FileEditRefusedError }> {
  return untilOwnersHold(async (learned) => {
    let refusal: FileEditRefusedError | undefined;
    let moved: TreeOwnersMoved | undefined;
    const locks = mergeOwnerLocks(
      ...grants.map((grant) => grantOwnerLocks(grant.facts)),
      { workIds: [...(alsoLock?.works ?? [])], lineageRootIds: [...(alsoLock?.lineages ?? [])] },
      learned.owners,
    );
    const confirmation: EditConfirmation = {
      workIds: locks.workIds,
      lineageRootIds: locks.lineageRootIds,
      async confirm(locked) {
        try {
          const refused = await access.confirmEdit(grants, locked);
          if (refused.length === 0) return;
          refusal = new FileEditRefusedError(refused);
          throw refusal;
        } catch (cause) {
          if (cause instanceof TreeOwnersMoved) moved = cause;
          throw cause;
        }
      },
      covers: (documentIds) => grantsCover(access, grants, documentIds),
    };
    try {
      const value = await runWithEditConfirmation(confirmation, operation);
      if (moved) throw moved;
      return refusal ? { ok: false, refusal } : { ok: true, value };
    } catch (cause) {
      if (moved) throw moved;
      if (refusal) return { ok: false, refusal };
      throw cause;
    }
  });
}

/**
 * Whether the grants cover a write to each document: a document grant names
 * it, or a container grant (a create) holds it, as the file just created.
 */
async function grantsCover(
  access: Pick<FileAccess, "authorize">,
  grants: readonly FileGrant<"edit" | "command">[],
  documentIds: readonly string[],
): Promise<boolean> {
  const named = new Set<string>();
  const containers: Array<Extract<FileTarget, { kind: "container" }>> = [];
  for (const {
    facts: { target },
  } of grants) {
    if (target.kind === "container") containers.push(target);
    else named.add(target.documentId);
  }
  const [grant] = grants;
  for (const documentId of documentIds) {
    if (named.has(documentId)) continue;
    if (!grant || containers.length === 0) return false;
    const found = await access.authorize(
      grant.principal,
      { kind: "document", documentId: documentId as never },
      "read",
    );
    if (isFileAccessDenied(found)) return false;
    if (!containers.some((container) => holds(container, found.facts))) return false;
  }
  return true;
}

function holds(container: Extract<FileTarget, { kind: "container" }>, facts: FileFacts): boolean {
  if (container.scheme !== facts.scheme) return false;
  const inProject = (projectId: string) =>
    facts.owner.kind === "project" && facts.owner.projectId === projectId;
  switch (container.owner.scope) {
    case "lineage":
      return (
        inProject(container.owner.projectId) &&
        facts.ownerRootThreadId === container.owner.rootThreadId
      );
    case "chat":
      return (
        inProject(container.owner.projectId) && facts.ownerChatThreadId === container.owner.threadId
      );
    case "project":
      return (
        facts.ownerWork === null &&
        !facts.ownerRootThreadId &&
        !facts.ownerChatThreadId &&
        inProject(container.owner.projectId)
      );
    case "account":
      return facts.owner.kind === "account" && facts.owner.userId === container.owner.userId;
    case "work":
      return facts.ownerWork?.id === container.owner.workId;
  }
}
