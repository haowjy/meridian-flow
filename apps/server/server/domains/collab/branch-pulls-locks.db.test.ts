/** A root pull must commit Work locks before acquiring the next branch mutex. */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createWorkProjectionMutation } from "../projects/adapters/work-projection-mutation.js";
import { createBranchCriticalSections } from "./domain/branch-critical-sections.js";
import { createBranchPullService } from "./domain/branch-pulls.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { createFixtureBranchStore } from "./test-support/fixture-branch-store.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("releases a pull's Work row before the next branch mutex while a receipt owns both", async () => {
  const harness = createHarness(db),
    view = harness.crossWorkProbeFixture(),
    responseId = randomUUID();
  await db.insert(schema.modelResponses).values({
    id: responseId as never,
    turnId: TURN_ID,
    sequence: 1,
    provider: "mock",
    model: "mock",
    requestMessageCount: 1,
    predictedCacheState: "cold",
    predictedCacheReason: "facts_unavailable",
  });
  await harness.seedWriterDocument("Alpha Beta.", responseId);
  await view.collab.agentEdit().write(
    {
      command: "replace",
      documentId: ALPHA_ID,
      file: "alpha.md",
      find: "Beta",
      content: "Gamma",
      tool_use_id: "pull-lock",
    },
    {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
      grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
    },
  );
  await harness.commit(responseId);
  harness.cancelScheduledPulls();
  const [a] = await db
    .select()
    .from(schema.documentBranches)
    .where(
      and(
        eq(schema.documentBranches.workId, WORK_ID),
        eq(schema.documentBranches.documentId, ALPHA_ID),
        eq(schema.documentBranches.kind, "work_draft"),
      ),
    );
  const [before] = await db.select().from(schema.works).where(eq(schema.works.id, WORK_ID));
  const locks = createBranchCriticalSections();
  const projection = createWorkProjectionMutation({
    db,
    availability: { advance: async () => {} },
    catalog: { upsertWorkAuthorities: async () => {} },
  } as unknown as Parameters<typeof createWorkProjectionMutation>[0]);
  const branches = createFixtureBranchStore(db, undefined, locks, projection);
  const live = new Y.Doc({ gc: false });
  Y.applyUpdate(live, a.state);
  const secondReached = gate(),
    receiptAcquired = gate();
  const secondId = "scheduled-second-draft";
  const pulls = createBranchPullService({
    outsideTransaction: runOutsideDrizzleTransaction,
    rootTransaction: (op) => runInRootDrizzleTransaction(db, op),
    liveCoordinator: {
      withDocument: async (_id: string, op: (doc: Y.Doc) => Promise<unknown>) => op(live),
    } as unknown as Parameters<typeof createBranchPullService>[0]["liveCoordinator"],
    branches: {
      listActiveWorkDraftBranchIds: async () => [a.id, secondId],
    } as unknown as Parameters<typeof createBranchPullService>[0]["branches"],
    branchCoordinator: {
      pullFromDoc: async (id: string) => {
        if (id === secondId) {
          secondReached.resolve();
          await receiptAcquired.promise;
        }
        await locks.withBranches([id], async () => {
          if (id === secondId) return;
          expect(
            await branches.updateBranchSnapshot({
              branchId: id,
              expectedGeneration: a.generation,
              expectedState: a.state,
              expectedStateVector: a.stateVector,
              state: a.state,
              stateVector: a.stateVector,
              liveCut: a.state,
            }),
          ).toBe(true);
        });
        return new Uint8Array();
      },
    } as unknown as Parameters<typeof createBranchPullService>[0]["branchCoordinator"],
  });
  try {
    const pull = pulls.flushLivePull(ALPHA_ID);
    await secondReached.promise;
    // NOWAIT is only a deterministic test oracle: a retained Work row would
    // deadlock a real receipt here. Failure releases the mutexes, so no timeout.
    const receipt = runInRootDrizzleTransaction(db, () =>
      locks.withBranches([a.id, secondId], async () => {
        receiptAcquired.resolve();
        await currentDrizzleDb(db).execute(
          sql`select id from works where id=${WORK_ID} for no key update nowait`,
        );
      }),
    );
    const [result] = await Promise.all([
      receipt.then(
        () => null,
        (error: unknown) => error,
      ),
      pull,
    ]);
    expect(result).toBeNull();
    const [after] = await db.select().from(schema.works).where(eq(schema.works.id, WORK_ID));
    const [saved] = await db
      .select()
      .from(schema.documentBranches)
      .where(eq(schema.documentBranches.id, a.id));
    expect(saved.hasEffect).toBe(false);
    expect(saved.liveCut).toEqual(a.state);
    expect(after.entityRevision).toBeGreaterThan(before.entityRevision);
  } finally {
    live.destroy();
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
