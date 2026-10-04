/**
 * Binds edit grants to a write call (file-access §5): every write seam the
 * call reaches locks the grants' Works with its own, in id order, and
 * confirms them inside its transaction before any advisory lock.
 */
import { type EditConfirmation, runWithEditConfirmation } from "../../shared/edit-confirmation.js";

export { markReplyConfirmed, UngrantedAgentWriteError } from "../../shared/edit-confirmation.js";

import {
  type FileAccessDenied,
  type FileFacts,
  type FileGrant,
  type FileTarget,
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

/** The named Works a grant's write locks: its owner and its draft's Work (§5). */
export function grantWorkIds(grants: readonly FileGrant[]): string[] {
  const ids = new Set<string>();
  for (const { facts } of grants) {
    if (facts.ownerWork && !facts.ownerWork.isNoWork) ids.add(facts.ownerWork.id);
    if (facts.draftWork && !facts.draftWork.isNoWork) ids.add(facts.draftWork.id);
  }
  return [...ids].sort();
}

/**
 * Runs `operation` with these grants bound. Returns the refusal a seam threw,
 * even when the write path caught the error and turned it into an outcome.
 */
export async function runWithEditGrants<T>(
  access: Pick<FileAccess, "authorize" | "confirmEdit">,
  grants: readonly FileGrant<"edit">[],
  operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; refusal: FileEditRefusedError }> {
  let refusal: FileEditRefusedError | undefined;
  const confirmation: EditConfirmation = {
    workIds: grantWorkIds(grants),
    async confirm() {
      const { refused } = await access.confirmEdit(grants);
      if (refused.length === 0) return;
      refusal = new FileEditRefusedError(refused);
      throw refusal;
    },
    covers: (documentIds) => grantsCover(access, grants, documentIds),
  };
  try {
    const value = await runWithEditConfirmation(confirmation, operation);
    return refusal ? { ok: false, refusal } : { ok: true, value };
  } catch (cause) {
    if (refusal) return { ok: false, refusal };
    throw cause;
  }
}

/**
 * Whether the grants cover a write to each document: a document grant names
 * it, or a container grant (a create) holds it, as the file just created.
 */
async function grantsCover(
  access: Pick<FileAccess, "authorize">,
  grants: readonly FileGrant<"edit">[],
  documentIds: readonly string[],
): Promise<boolean> {
  const named = new Set<string>();
  const containers: Array<Extract<FileTarget, { kind: "container" }>> = [];
  for (const { target } of grants) {
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
  return container.owner.scope === "project"
    ? facts.ownerWork === null && facts.projectId === container.owner.projectId
    : facts.ownerWork?.id === container.owner.workId;
}
