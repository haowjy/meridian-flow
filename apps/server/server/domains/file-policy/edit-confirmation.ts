/**
 * Binds edit grants to a write call (file-access §5): every write seam the
 * call reaches locks the grants' Works with its own, in id order, and
 * confirms them inside its transaction before any advisory lock.
 */
import { type EditConfirmation, runWithEditConfirmation } from "../../shared/edit-confirmation.js";

export { markReplyConfirmed, UngrantedAgentWriteError } from "../../shared/edit-confirmation.js";

import type { FileAccessDenied, FileGrant } from "./domain/types.js";
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
  access: Pick<FileAccess, "confirmEdit">,
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
  };
  try {
    const value = await runWithEditConfirmation(confirmation, operation);
    return refusal ? { ok: false, refusal } : { ok: true, value };
  } catch (cause) {
    if (refusal) return { ok: false, refusal };
    throw cause;
  }
}
