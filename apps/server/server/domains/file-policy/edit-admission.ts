import type { WorkProjectionMutation, WorkWriteSet } from "../projects/index.js";
import type { FileGrant } from "./domain/types.js";
import { type FileEditRefusedError, runWithEditGrants } from "./edit-confirmation.js";
import type { FileAccess } from "./file-access.js";

export type EditAdmissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: FileEditRefusedError };

/**
 * Binds grants before entering the caller's commit scope, then locks the Work seam before the
 * caller's mutation scope. The command's one restart loop is `untilOwnersHold`, owned by the transaction's
 * owner (`runCommand`): a moved owner any layer finds restarts the whole command.
 */
export async function runEditAdmission<T>(input: {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  grants: readonly FileGrant<"edit">[] | null;
  workProjection: Pick<WorkProjectionMutation, "mutate">;
  works: WorkWriteSet;
  commitScope(operation: () => Promise<T>): Promise<T>;
  acquireMutationScope(): Promise<void>;
  operation(): Promise<T>;
}): Promise<EditAdmissionResult<T>> {
  const commit = () =>
    input.commitScope(() =>
      input.workProjection.mutate(
        input.works,
        async () => {
          await input.acquireMutationScope();
          return input.operation();
        },
        { seam: true },
      ),
    );
  return input.grants
    ? runWithEditGrants(input.fileAccess, input.grants, commit)
    : { ok: true, value: await commit() };
}
