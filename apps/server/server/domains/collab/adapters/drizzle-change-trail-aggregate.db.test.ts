/** PostgreSQL contracts for committed change-event replace-set projections. */

import type { TrailChangeV1 } from "@meridian/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  db,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "../test-support/change-trail-postgres-harness.js";
import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

function change(input: {
  id: string;
  pushId: string;
  clientID: number;
  before?: string | null;
  after?: string | null;
}): TrailChangeV1 {
  return {
    changeId: input.id,
    ordinal: 0,
    documentId: ALPHA_ID,
    pushId: input.pushId,
    receiptId: null,
    kind: input.before === null ? "insert" : "modify",
    beforeBlockId: input.before === null ? null : input.id,
    afterBlockId: input.after === null ? null : input.id,
    beforeBlockIdentity:
      input.before === null ? null : { documentId: ALPHA_ID, clientID: input.clientID, clock: 0 },
    afterBlockIdentity:
      input.after === null ? null : { documentId: ALPHA_ID, clientID: input.clientID, clock: 0 },
    beforeText: input.before ?? `before-${input.id}|before ${input.id}`,
    afterTextAtReceipt: input.after ?? `after-${input.id}|after ${input.id}`,
    navigation: { kind: "unavailable", reason: "fixture" },
    swept: null,
    reversible: false,
  };
}

const owner = { kind: "turn" as const, threadId: THREAD_ID, turnId: TURN_ID };
const titles = new Map([[ALPHA_ID, "Alpha"]]);
const trail = (changes: TrailChangeV1[]) => ({
  owner,
  changes,
  counts: { changes: changes.length, swept: 0, documents: changes.length === 0 ? 0 : 1 },
});

describe("change trail aggregate projections (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("keeps cumulative changes attributed to the push that admitted each one", async () => {
    const [autoPush, manualPush] = await db
      .insert(schema.pushLineage)
      .values([
        {
          documentId: ALPHA_ID,
          pushKind: "whole",
          journalIds: [],
          idempotencyKey: "attribution-auto",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          pushedByUserId: null,
        },
        {
          documentId: ALPHA_ID,
          pushKind: "whole",
          journalIds: [],
          idempotencyKey: "attribution-manual",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          pushedByUserId: USER_ID,
        },
      ])
      .returning({ id: schema.pushLineage.id });
    if (!autoPush || !manualPush) throw new Error("missing push fixtures");
    const writer = createDrizzleChangeTrailAggregateWriter(db);
    const autoChange = change({ id: "auto", pushId: String(autoPush.id), clientID: 10 });
    const manualChange = change({ id: "manual", pushId: String(manualPush.id), clientID: 20 });

    await writer.record({ trails: [trail([autoChange])], documentTitles: titles });
    const second = await writer.record({
      trails: [trail([manualChange])],
      documentTitles: titles,
    });

    expect(second).toMatchObject([
      {
        owner,
        documentId: ALPHA_ID,
        projectionRevision: 2,
        changes: [
          { changeId: "auto", admittedByUserId: null },
          { changeId: "manual", admittedByUserId: USER_ID },
        ],
      },
    ]);
  });

  it("retains a monotonic replace-set revision through clearing and adapter restart", async () => {
    const [push] = await db
      .insert(schema.pushLineage)
      .values({
        documentId: ALPHA_ID,
        pushKind: "whole",
        journalIds: [],
        idempotencyKey: "revision-continuity",
        threadId: THREAD_ID,
        turnId: TURN_ID,
      })
      .returning({ id: schema.pushLineage.id });
    if (!push) throw new Error("missing push fixture");
    const pushId = String(push.id);
    const initial = change({ id: "continuity", pushId, clientID: 30 });
    const firstWriter = createDrizzleChangeTrailAggregateWriter(db);

    const first = await firstWriter.record({
      trails: [trail([initial])],
      documentTitles: titles,
    });
    const empty = await firstWriter.record({
      trails: [trail([])],
      documentTitles: titles,
      refineCurrentVersion: true,
      replacePushId: pushId,
    });
    expect(empty).toMatchObject([{ documentId: ALPHA_ID, projectionRevision: 2, changes: [] }]);
    expect(
      await db
        .select()
        .from(schema.changeTrailDocumentDetails)
        .where(eq(schema.changeTrailDocumentDetails.documentId, ALPHA_ID)),
    ).toEqual([]);

    const restartedWriter = createDrizzleChangeTrailAggregateWriter(db);
    const restored = await restartedWriter.record({
      trails: [trail([{ ...initial, afterTextAtReceipt: "restored|after restart" }])],
      documentTitles: titles,
      refineCurrentVersion: true,
      replacePushId: pushId,
    });
    const updated = await restartedWriter.record({
      trails: [trail([{ ...initial, afterTextAtReceipt: "updated|fourth projection" }])],
      documentTitles: titles,
      refineCurrentVersion: true,
      replacePushId: pushId,
    });

    expect(
      [first, empty, restored, updated].map((result) => result[0]?.projectionRevision),
    ).toEqual([1, 2, 3, 4]);
    expect(restored[0]?.changes).toEqual([
      expect.objectContaining({ afterTextAtReceipt: "restored|after restart" }),
    ]);
    expect(updated[0]?.changes).toEqual([
      expect.objectContaining({ afterTextAtReceipt: "updated|fourth projection" }),
    ]);
  });
});
