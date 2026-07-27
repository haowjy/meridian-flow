/** Real-Postgres behavioral coverage for change-trail durability. */
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  db,
  resetDatabase,
  schema,
  truncateDrizzleTables,
} from "./test-support/change-trail-postgres-harness.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

describe("change trail (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("persists an auto-push receipt without a model-context notice", async () => {
    const success = createHarness();
    const successBranchId = await success.seedDestructivePush("push-receipt-success");
    const beforeSuccess = await success.liveMarkdown(ALPHA_ID);
    await expect(success.autoPush(successBranchId)).resolves.toMatchObject({ status: "pushed" });
    expect(await success.liveMarkdown(ALPHA_ID)).not.toEqual(beforeSuccess);
    expect(await success.noticeRows()).toEqual([]);
    expect(await success.trailRowMembership()).toMatchObject({
      shells: [{}],
      details: [{}],
      outbox: [{}],
    });
  });

  it("rolls content, lineage, shell, detail, and outbox back at every trail insert boundary", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("trail-insert-boundaries");
    const beforeMarkdown = await harness.liveMarkdown(ALPHA_ID);
    const beforeUpdates = await harness.liveUpdateCount();

    for (const table of [
      "change_trail_shells",
      "change_trail_document_details",
      "change_trail_delivery_outbox",
    ]) {
      await db.execute(
        sql.raw(`
          CREATE OR REPLACE FUNCTION inject_change_trail_failure() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ${table} failure'; END $$;
          CREATE TRIGGER inject_change_trail_failure
          BEFORE INSERT ON ${table}
          FOR EACH ROW EXECUTE FUNCTION inject_change_trail_failure();
        `),
      );
      try {
        await expect(harness.autoPush(branchId)).rejects.toThrow();
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER inject_change_trail_failure ON ${table}`));
      }
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe(beforeMarkdown);
      expect(await harness.liveUpdateCount()).toBe(beforeUpdates);
      expect(await harness.pushRows()).toEqual([]);
      expect(await harness.trailRowMembership()).toEqual({ shells: [], details: [], outbox: [] });
      expect(await harness.noticeRows()).toEqual([]);
      expect(await harness.activePushJournalCount()).toBe(1);
    }
    await db.execute(sql.raw("DROP FUNCTION inject_change_trail_failure()"));
  });

  it("persists proven replacements as live ranges and deletes conservatively", async () => {
    const proven = createHarness();
    const provenBranchId = await proven.seedDestructivePush("proven-replacement", ALPHA_ID, true);
    await proven.autoPush(provenBranchId);
    const provenChange = (await proven.trailRowMembership()).details[0]?.changes[0];
    expect(provenChange).toMatchObject({
      kind: "modify",
      navigation: { kind: "live_block_range", targetBlockId: expect.any(Object) },
    });

    await truncateDrizzleTables(db, [
      schema.changeTrailDeliveryOutbox,
      schema.changeTrailDocumentDetails,
      schema.changeTrailShells,
      schema.pendingNotices,
      schema.agentEditMutations,
      schema.branchWriteJournal,
      schema.pushLineage,
      schema.documentBranches,
      schema.documentYjsCheckpoints,
      schema.documentYjsHeads,
      schema.documentYjsUpdates,
    ]);
    const conservative = createHarness();
    const conservativeBranchId = await conservative.seedDestructivePush("conservative-delete");
    await conservative.autoPush(conservativeBranchId);
    const conservativeChange = (await conservative.trailRowMembership()).details[0]?.changes[0];
    expect(conservativeChange).toMatchObject({
      kind: "delete",
      navigation: { kind: "deletion_boundary" },
    });
  });

  it("commits normalized trail state once and reuses it on an already-pushed retry", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("trail-commit-retry");
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    const committed = await harness.trailRowMembership();
    expect(committed.shells).toHaveLength(1);
    expect(committed.details).toHaveLength(1);
    expect(committed.outbox).toHaveLength(1);
    const changes = committed.details[0]?.changes ?? [];
    expect(committed.shells[0]).toMatchObject({
      changeCount: changes.length,
      documentCount: 1,
    });

    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "already_pushed" });
    expect(await harness.trailRowMembership()).toEqual(committed);
  });

  it("keeps a mixed-owner push turn-owned and preserves its shell across document deletion", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("trail-shared-delete");
    await harness.makeJournalOwnershipMixed();
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    const beforeDelete = await harness.trailRowMembership();
    expect(beforeDelete.shells).toEqual([
      expect.objectContaining({ ownerKind: "turn", turnId: expect.any(String), changeCount: 1 }),
    ]);
    expect(await harness.pushRows()).toEqual([expect.objectContaining({ turnId: null })]);

    await harness.hardDeleteDocument(ALPHA_ID);
    const afterDocumentDelete = await harness.trailRowMembership();
    expect(afterDocumentDelete.shells).toEqual(beforeDelete.shells);
    expect(afterDocumentDelete.details).toEqual([]);
    expect(afterDocumentDelete.outbox).toEqual(beforeDelete.outbox);

    await harness.hardDeleteThread();
    expect(await harness.trailRowMembership()).toEqual({ shells: [], details: [], outbox: [] });
  });
});
