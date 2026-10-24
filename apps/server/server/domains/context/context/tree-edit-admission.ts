/**
 * Shared admission order for tree edits that may revive a removed document.
 */

import type { Database } from "@meridian/database";
import type { FileGrant } from "../../file-policy/domain/types.js";
import {
  type FileAccess,
  type FileEditRefusedError,
  runWithEditGrants,
} from "../../file-policy/index.js";
import type { WorkProjectionMutation, WorkWriteSet } from "../../projects/index.js";
import type { TreeScopeRequest } from "../tree/mutation-scope.js";
import { acquireTreeScope } from "../tree/mutation-scope.js";

export type TreeEditAdmissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: FileEditRefusedError };

/**
 * Binds grants before entering the caller's commit scope, then locks the Work seam before the
 * tree scope. Retry ownership stays with the caller because inverse retries must recapture plans.
 */
export async function runTreeEditAdmission<T>(input: {
  db: Database;
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  grants: readonly FileGrant<"edit">[] | null;
  workProjection: Pick<WorkProjectionMutation, "mutate">;
  works: WorkWriteSet;
  tree: TreeScopeRequest;
  commitScope(operation: () => Promise<T>): Promise<T>;
  afterTreeLock?(): Promise<void>;
  operation(): Promise<T>;
}): Promise<TreeEditAdmissionResult<T>> {
  const commit = () =>
    input.commitScope(() =>
      input.workProjection.mutate(
        input.works,
        async () => {
          await acquireTreeScope(input.db, input.tree);
          await input.afterTreeLock?.();
          return input.operation();
        },
        { seam: true },
      ),
    );
  return input.grants
    ? runWithEditGrants(input.fileAccess, input.grants, commit)
    : { ok: true, value: await commit() };
}
