/** Real push-service regressions for settlement refinement and rewrite projection. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  resetDatabase,
} from "./test-support/change-trail-postgres-harness.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

type ProjectedChange = {
  kind: string;
  beforeText: string | null;
  afterTextAtReceipt: string | null;
  swept: unknown;
  writerProtection?: unknown;
  navigation: { kind: string };
};

describe("branch push settlement refinement (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("retains ordinary thread-peer insertions through final settlement and delivery", async () => {
    const harness = createHarness();
    const branchIds = await harness.seedAndStage("ordinary-insertion");
    await harness.commit("ordinary-insertion");
    for (const branchId of branchIds) {
      await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    }
    await harness.recoverPendingLiveSettlements();

    const trails = await harness.trailRows();
    expect(trails.shells).toEqual([expect.objectContaining({ changeCount: 2, documentCount: 2 })]);
    expect(trails.details).toHaveLength(2);
    expect(trails.details.flatMap((detail) => detail.changes as ProjectedChange[])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "insert", afterTextAtReceipt: "Agent alpha." }),
        expect.objectContaining({ kind: "insert", afterTextAtReceipt: "Agent beta." }),
      ]),
    );
    expect({
      events: harness.changeEvents(),
      projections: harness.settlementProjections(),
      refinements: harness.settlementRefinements(),
    }).toEqual({
      events: expect.arrayContaining([
        expect.objectContaining({
          documentId: ALPHA_ID,
          projectionRevision: 2,
          changes: [expect.objectContaining({ kind: "insert" })],
        }),
      ]),
      projections: expect.any(Array),
      refinements: ["refine_classifications", "refine_classifications"],
    });
    await expect(harness.diff()).resolves.toMatchObject({ command: "diff", status: "success" });
    harness.destroyWarmState();
  });

  it("demotes an observed rewrite's provisional sweep without erasing the modification", async () => {
    const harness = createHarness();
    const branchId = await harness.seedAndStageDestructive(
      "00000000-0000-4000-8000-000000000821",
      ALPHA_ID,
      true,
      "Writer original.",
      0,
      true,
      true,
      true,
    );
    await harness.commit("00000000-0000-4000-8000-000000000821");
    await expect(harness.activeJournalWriteShape()).resolves.toEqual({
      rowCount: 1,
      operationCount: 0,
      stableIdentity: true,
    });
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    await harness.recoverPendingLiveSettlements();

    const trails = await harness.trailRows();
    const changes = trails.details.flatMap((detail) => detail.changes as ProjectedChange[]);
    expect(trails.shells).toEqual([
      expect.objectContaining({ changeCount: 1, sweptChangeCount: 0, documentCount: 1 }),
    ]);
    expect(changes).toEqual([
      expect.objectContaining({
        kind: "modify",
        swept: null,
        navigation: expect.objectContaining({ kind: "live_block_range" }),
      }),
    ]);
    expect(changes[0]).not.toHaveProperty("writerProtection");
    expect(harness.changeEvents()).toEqual([
      expect.objectContaining({
        projectionRevision: 2,
        changes: [expect.objectContaining({ kind: "modify", swept: false })],
      }),
    ]);
    await expect(harness.diff()).resolves.toMatchObject({ command: "diff", status: "success" });
    harness.destroyWarmState();
  });

  it("commits and broadcasts an advanced empty replace-set for a true empty contribution", async () => {
    const harness = createHarness();
    const responseId = "00000000-0000-4000-8000-000000000823";
    const branchId = await harness.seedAndStageDestructive(
      responseId,
      ALPHA_ID,
      true,
      "Writer original.",
      0,
      true,
      true,
      true,
    );
    await harness.commit(responseId);
    await harness.makeJournalOwnershipNull();
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    await harness.recoverPendingLiveSettlements();

    const trails = await harness.trailRows();
    expect(trails.shells).toEqual([
      expect.objectContaining({ changeCount: 0, sweptChangeCount: 0, documentCount: 0 }),
    ]);
    expect(trails.details).toEqual([]);
    expect(harness.changeEvents()).toEqual([
      expect.objectContaining({
        documentId: ALPHA_ID,
        projectionRevision: 2,
        changes: [],
      }),
    ]);
    await expect(harness.diff()).resolves.toMatchObject({ command: "diff", status: "success" });
    harness.destroyWarmState();
  });
});
