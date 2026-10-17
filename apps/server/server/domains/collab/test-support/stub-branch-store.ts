/** Unit-test branch rows and stores: fixed rows whose content is their checkpoint, with no tail. */
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type {
  AppendRowsInput,
  BranchSnapshot,
  BranchStore,
  CommitRewriteInput,
} from "../domain/branch-coordinator.js";

/** A branch row, defaulting every field the test does not name. */
export function testBranchRow(
  input: Pick<BranchSnapshot, "branchId" | "documentId"> & Partial<BranchSnapshot>,
): BranchSnapshot {
  return {
    kind: "work_draft",
    upstreamBranchId: null,
    draftId: "draft-1" as BranchSnapshot["draftId"],
    workId: null,
    threadId: null,
    status: "active",
    generation: 1,
    revision: 0,
    checkpointRevision: 0,
    checkpointSeq: 0,
    frozen: false,
    hasEffect: false,
    blocking: false,
    schemaVersion: COLLAB_SCHEMA_VERSION,
    ...input,
  };
}

/** A row and the content its checkpoint holds. */
export type StubBranch = { branch: BranchSnapshot; state: Uint8Array };

/**
 * Reads serve each row with its content as the checkpoint. A rewrite is accepted without
 * storing anything (the reported revision moves); an append refuses unless `appends` accepts.
 */
export function stubBranchStore(input: {
  branch(branchId: string): StubBranch | null | undefined;
  appends?: "accept" | "refuse";
  onAppend?(append: AppendRowsInput): void | Promise<void>;
  onRewrite?(rewrite: CommitRewriteInput): void | Promise<void>;
  deferUntilCommit?: BranchStore["deferUntilCommit"];
}): BranchStore {
  const find = (branchId: string) => input.branch(branchId) ?? null;
  return {
    deferUntilCommit: input.deferUntilCommit ?? (() => false),
    async getBranch(branchId) {
      return find(branchId)?.branch ?? null;
    },
    async readBranchAt(branchId) {
      const found = find(branchId);
      if (!found) return null;
      return {
        branch: found.branch,
        checkpoint: {
          state: found.state,
          stateVector: Y.encodeStateVectorFromUpdate(found.state),
        },
        tail: [],
      };
    },
    async appendRows(append) {
      if (input.appends !== "accept")
        throw new Error("This test store does not exercise atomic branch mutations");
      await input.onAppend?.(append);
      return {
        status: "appended",
        revision: append.expectedRevision + 1,
        rowIds: append.rows.map((_, index) => index + 1),
      };
    },
    async commitRewrite(rewrite) {
      await input.onRewrite?.(rewrite);
      const found = find(rewrite.branchId);
      const revision = (found?.branch.revision ?? 0) + 1;
      return {
        status: "committed",
        revision,
        checkpointRevision: revision,
        seq: 0,
        generation: (found?.branch.generation ?? 1) + (rewrite.operation.kind === "reset" ? 1 : 0),
      };
    },
  };
}
