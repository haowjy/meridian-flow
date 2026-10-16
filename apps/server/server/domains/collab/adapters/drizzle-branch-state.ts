/**
 * The one raw compare-and-swap of a branch's state, private to the branch store. It writes the state,
 * the work draft's `has_effect` and its `base_revision` or rebase cuts together or not at all, so nothing
 * re-derives the effect afterwards. A text branch's `has_effect` is `review_base ≠ prosemirror` of the
 * document being written (`draftDiffersFromBase`); the caller computes it from that document and
 * passes it in the effect arm. The Work projection wraps this write in the store's `writeBranchState`.
 */

import { documentBranches } from "@meridian/database";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  packCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { PersistBranchInput } from "../domain/branch-coordinator.js";

/** The stored schema stamp never moves backwards: the greater of the row's, the given and the running one. */
export function monotonicSchemaStamp(version: CollabSchemaVersion = COLLAB_SCHEMA_VERSION) {
  const packedVersion = packCollabSchemaVersion(version);
  const packedRunningVersion = packCollabSchemaVersion(COLLAB_SCHEMA_VERSION);
  return sql<number>`greatest(
    ${documentBranches.schemaVersion},
    ${packedVersion},
    ${packedRunningVersion}
  )`;
}

export async function casBranchState(db: DrizzleDb, input: PersistBranchInput): Promise<boolean> {
  const [row] = await db
    .update(documentBranches)
    .set({
      state: Buffer.from(input.state),
      stateVector: Buffer.from(input.stateVector),
      schemaVersion: monotonicSchemaStamp(),
      updatedAt: new Date(),
      ...(input.effect.kind === "text" ? { hasEffect: input.effect.hasEffect } : {}),
      ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
    })
    .where(
      and(
        eq(documentBranches.id, input.branchId),
        eq(documentBranches.status, "active"),
        eq(documentBranches.state, Buffer.from(input.expectedState)),
      ),
    )
    .returning({ id: documentBranches.id });
  return Boolean(row);
}
