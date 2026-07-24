/** PostgreSQL contract coverage for the turn-diff read adapter. */

import type { TrailChangeV1 } from "@meridian/contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  db,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
} from "../test-support/change-trail-postgres-harness.js";
import { createDrizzleTurnDiffQuery } from "./drizzle-turn-diff-query.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

function change(documentId: string, id: string): TrailChangeV1 {
  return {
    changeId: id,
    ordinal: 0,
    documentId,
    pushId: null,
    receiptId: `receipt-${id}`,
    kind: "modify",
    beforeBlockId: null,
    afterBlockId: null,
    beforeText: "Before",
    afterTextAtReceipt: "After",
    navigation: { kind: "unavailable", reason: "fixture" },
    swept: null,
    reversible: false,
  };
}

describe("turn diff query (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("honors turn ownership, document narrowing, shell state, and live shared details", async () => {
    const turnTrailId = "00000000-0000-4000-8000-000000000901";
    const sharedTrailId = "00000000-0000-4000-8000-000000000902";
    await db.insert(schema.changeTrailShells).values([
      {
        id: turnTrailId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        ownerKind: "turn",
        state: "settled",
        settledAt: new Date(),
        changeCount: 2,
        sweptChangeCount: 0,
        documentCount: 2,
      },
      {
        id: sharedTrailId,
        threadId: THREAD_ID,
        turnId: null,
        ownerKind: "shared",
        state: "building",
        changeCount: 1,
        sweptChangeCount: 0,
        documentCount: 1,
      },
    ]);
    await db.insert(schema.changeTrailDocumentDetails).values([
      {
        trailId: turnTrailId,
        documentId: ALPHA_ID,
        documentTitle: "Alpha",
        changes: [change(ALPHA_ID, "alpha")],
      },
      {
        trailId: turnTrailId,
        documentId: BETA_ID,
        documentTitle: "Beta",
        changes: [change(BETA_ID, "beta")],
      },
      {
        trailId: sharedTrailId,
        documentId: ALPHA_ID,
        documentTitle: "Alpha",
        changes: [change(ALPHA_ID, "shared")],
      },
    ]);

    const query = createDrizzleTurnDiffQuery(db);
    await expect(query.query(THREAD_ID, TURN_ID, ALPHA_ID)).resolves.toEqual({
      trailState: "settled",
      changes: [expect.objectContaining({ documentId: ALPHA_ID })],
      sharedEffects: true,
    });
    await expect(query.query(THREAD_ID, TURN_ID, BETA_ID)).resolves.toEqual({
      trailState: "settled",
      changes: [expect.objectContaining({ documentId: BETA_ID })],
      sharedEffects: false,
    });

    // Occurrences are revision cursors and may outlive an empty refinement.
    await db.insert(schema.changeTrailDocumentOccurrences).values({
      trailId: sharedTrailId,
      documentId: ALPHA_ID,
      projectionRevision: 4,
    });
    await db
      .delete(schema.changeTrailDocumentDetails)
      .where(
        and(
          eq(schema.changeTrailDocumentDetails.trailId, sharedTrailId),
          eq(schema.changeTrailDocumentDetails.documentId, ALPHA_ID),
        ),
      );
    await expect(query.query(THREAD_ID, TURN_ID, ALPHA_ID)).resolves.toMatchObject({
      sharedEffects: false,
    });
  });
});
