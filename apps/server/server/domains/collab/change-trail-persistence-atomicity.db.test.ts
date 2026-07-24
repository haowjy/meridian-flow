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

  it("persists an auto-push sweep in its durable trail without a model-context notice", async () => {
    const success = createHarness();
    const successBranchId = await success.seedDestructivePush("push-swept-success");
    const beforeSuccess = await success.liveMarkdown(ALPHA_ID);
    await expect(success.autoPush(successBranchId)).resolves.toMatchObject({
      status: "pushed",
      swept: { reversible: false },
    });
    expect(await success.liveMarkdown(ALPHA_ID)).not.toEqual(beforeSuccess);
    expect(await success.noticeRows()).toEqual([]);
    expect(await success.trailRows()).toMatchObject({
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
      expect(await harness.trailRows()).toEqual({ shells: [], details: [], outbox: [] });
      expect(await harness.noticeRows()).toEqual([]);
      expect(await harness.activePushJournalCount()).toBe(1);
    }
    await db.execute(sql.raw("DROP FUNCTION inject_change_trail_failure()"));
  });

  it("atomically records selective-push trail state and rolls back when trail recording fails", async () => {
    const success = createHarness();
    const selected = await success.seedSelectivePush();
    await expect(success.selectivePush(selected)).resolves.toMatchObject({ status: "pushed" });
    expect(await success.trailRows()).toMatchObject({
      shells: [{}],
      details: [
        {
          changes: [expect.objectContaining({ kind: "insert", swept: null })],
        },
      ],
      outbox: [{}],
    });

    await truncateDrizzleTables(db, [
      schema.changeTrailDeliveryOutbox,
      schema.changeTrailDocumentDetails,
      schema.changeTrailShells,
      schema.agentEditMutations,
      schema.branchWriteJournal,
      schema.pushLineage,
      schema.documentBranches,
      schema.documentYjsCheckpoints,
      schema.documentYjsHeads,
      schema.documentYjsUpdates,
    ]);
    const failed = createHarness();
    const failedSelected = await failed.seedSelectivePush();
    const before = await failed.liveMarkdown(ALPHA_ID);
    await db.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION inject_selective_trail_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected selective trail failure'; END $$;
        CREATE TRIGGER inject_selective_trail_failure BEFORE INSERT ON change_trail_shells
        FOR EACH ROW EXECUTE FUNCTION inject_selective_trail_failure();
      `),
    );
    try {
      await expect(failed.selectivePush(failedSelected)).rejects.toThrow();
    } finally {
      await db.execute(
        sql.raw("DROP TRIGGER inject_selective_trail_failure ON change_trail_shells"),
      );
      await db.execute(sql.raw("DROP FUNCTION inject_selective_trail_failure()"));
    }
    expect(await failed.liveMarkdown(ALPHA_ID)).toBe(before);
    expect(await failed.pushRows()).toEqual([]);
    expect(await failed.trailRows()).toEqual({ shells: [], details: [], outbox: [] });
    expect(await failed.activePushJournalCount()).toBe(1);
  });

  it("persists proven swept replacements as immutable live ranges and deletes conservatively", async () => {
    const proven = createHarness();
    const provenBranchId = await proven.seedDestructivePush("proven-replacement", ALPHA_ID, true);
    await proven.autoPush(provenBranchId);
    const provenChange = (await proven.trailRows()).details[0]?.changes.find(
      (change) => (change as { swept?: unknown }).swept,
    );
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
    const conservativeChange = (await conservative.trailRows()).details[0]?.changes.find(
      (change) => (change as { swept?: unknown }).swept,
    );
    expect(conservativeChange).toMatchObject({
      kind: "delete",
      navigation: { kind: "deletion_boundary" },
    });
  });

  it("commits normalized trail state once and reuses it on an already-pushed retry", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("trail-commit-retry");
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    const committed = await harness.trailRows();
    expect(committed.shells).toHaveLength(1);
    expect(committed.details).toHaveLength(1);
    expect(committed.outbox).toHaveLength(1);
    const changes = (committed.details[0]?.changes ?? []) as Array<{ swept: unknown }>;
    expect(committed.shells[0]).toMatchObject({
      changeCount: changes.length,
      sweptChangeCount: changes.filter((change) => change.swept).length,
      documentCount: 1,
    });

    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "already_pushed" });
    expect(await harness.trailRows()).toEqual(committed);
  });

  it("keeps a mixed-owner push shared and preserves its shell across document deletion", async () => {
    const harness = createHarness();
    const branchId = await harness.seedDestructivePush("trail-shared-delete");
    await harness.makeJournalOwnershipMixed();
    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
    const beforeDelete = await harness.trailRows();
    expect(beforeDelete.shells).toEqual([
      expect.objectContaining({ ownerKind: "shared", turnId: null, changeCount: 1 }),
    ]);
    expect(await harness.pushRows()).toEqual([expect.objectContaining({ turnId: null })]);

    await harness.hardDeleteDocument(ALPHA_ID);
    const afterDocumentDelete = await harness.trailRows();
    expect(afterDocumentDelete.shells).toEqual(beforeDelete.shells);
    expect(afterDocumentDelete.details).toEqual([]);
    expect(afterDocumentDelete.outbox).toEqual(beforeDelete.outbox);

    await harness.hardDeleteThread();
    expect(await harness.trailRows()).toEqual({ shells: [], details: [], outbox: [] });
  });
});
