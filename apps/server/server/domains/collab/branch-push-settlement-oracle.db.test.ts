/** PostgreSQL cold cut, stale-claim fencing and commit-fault proofs. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentDrizzleDb, runAfterDrizzleCommit } from "../../shared/drizzle-transaction.js";
import { createWorkProjectionMutation } from "../projects/adapters/work-projection-mutation.js";
import type { SettlementBatchScope } from "./domain/ports/settlement-publication.js";
import {
  ALPHA_ID,
  appliedMarkdown,
  BETA_ID,
  COLD_SCENARIO_IDS,
  claimProbeStore,
  closeDatabase,
  createHarness,
  createTestDatabase,
  expectLiveSweepOnly,
  expireAllPendingClaims,
  expirePendingClaims,
  GAMMA_ID,
  liveDurableState,
  markdownFromUpdate,
  observeSettlement,
  PROJECT_ID,
  resetSettlementFixture,
  runInRootDrizzleTransaction,
  SOURCE_ID,
  schema,
  settlementStates,
  stallAfterFirstUpdate,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import {
  runOutsideDrizzleTransaction,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { settlementOracle } from "./test-support/durable-settlement-oracle.js";

const BATCH = [ALPHA_ID, BETA_ID, GAMMA_ID] as const;

describe("durable branch-push settlement oracle (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetSettlementFixture(db));
  afterAll(() => closeDatabase(db));

  async function seedBatch(harness: ReturnType<typeof createHarness>): Promise<string[]> {
    const branchIds: string[] = [];
    for (const documentId of BATCH) {
      branchIds.push(await harness.seedDestructivePush(`batch-${documentId}`, documentId));
    }
    return branchIds;
  }

  it("settles a batch in one root-owned transaction; warm rooms, then ordered effects, then every drained branch reset", async () => {
    let harness!: ReturnType<typeof createHarness>;
    let broadcastsBefore = 0;
    const roomsDuringAdmission: string[][] = [];
    const effects: string[] = [];
    let competingWrite: (() => Promise<void>) | undefined;
    // Attempt 1: a writer reaches beta (not the first member) after its drain, so the
    // batch retries before anything admits. Attempt 2: the lease expires after the first
    // admission, so the whole attempt rolls back. Attempt 3 settles.
    let attempts = 0;
    let lateWriter = true;
    let expireAfterAdmission = false;
    harness = createHarness(db, {
      async afterClassification({ documentId }) {
        if (documentId === ALPHA_ID) attempts += 1;
        if (documentId === BETA_ID && lateWriter) {
          lateWriter = false;
          expireAfterAdmission = true;
          await harness.appendWriterPrefix(BETA_ID, "Writer late: ");
          // The writer's own edit reached its room; settlement's must wait for commit.
          broadcastsBefore = harness.liveRoomBroadcasts().length;
        }
      },
      async afterAdmission() {
        roomsDuringAdmission.push(harness.liveRoomBroadcasts().slice(broadcastsBefore));
        if (attempts === 2 && expireAfterAdmission) {
          expireAfterAdmission = false;
          await harness.expireLeaseInTransaction();
        }
      },
      // Another process writes the second member's draft after the batch staged it.
      afterDurableCommit: async () => competingWrite?.(),
      publicationSteps: [
        {
          kind: "test_first_effect",
          async plan() {
            return {
              async afterCommit() {
                const rooms = new Set(harness.liveRoomBroadcasts().slice(broadcastsBefore));
                effects.push(`step 1 started with ${rooms.size} warm rooms`);
                await new Promise((resolve) => setTimeout(resolve, 20));
                effects.push("step 1 failed");
                throw new Error("injected after-commit failure");
              },
            };
          },
        },
        {
          kind: "test_second_effect",
          async plan() {
            return {
              afterCommit() {
                effects.push("step 2 ran");
              },
            };
          },
        },
      ],
    });
    const [alpha, beta, gamma] = (await seedBatch(harness)) as [string, string, string];
    // Request order is not document order; items answer in request order.
    const request = [gamma, alpha, beta];
    const generations = await Promise.all(request.map((id) => harness.branchGeneration(id)));
    broadcastsBefore = harness.liveRoomBroadcasts().length;

    await expect(
      runInRootDrizzleTransaction(db, () => harness.pushBranches(request, "auto")),
    ).rejects.toThrow(/root-owned/);
    expect(await db.select().from(schema.pushLineage)).toEqual([]);

    const competitor = createHarness(db);
    competingWrite = async () => {
      competingWrite = undefined;
      await competitor.stageAnotherDestructiveEdit(beta);
    };
    const result = await harness.pushBranches(request, "auto");

    expect(result.items).toEqual(
      [GAMMA_ID, ALPHA_ID, BETA_ID].map((documentId, index) =>
        expect.objectContaining({
          status: "pushed",
          push: expect.objectContaining({ branchId: request[index], documentId }),
        }),
      ),
    );
    expect(attempts).toBe(3);
    // Three admissions in attempt 2, which the expiry rolled back, and three in attempt 3:
    // no warm room changed before commit, and nothing admitted twice.
    expect(roomsDuringAdmission).toEqual([[], [], [], [], [], []]);
    for (const document of await liveDurableState(db, BATCH)) {
      expect(document.updates.filter((origin) => origin === "reconcile")).toHaveLength(1);
    }
    const betaJoins = await db
      .select({ sourceKind: schema.branchPushOutboxUpdates.sourceKind })
      .from(schema.branchPushOutboxUpdates)
      .innerJoin(
        schema.branchPushSettlementOutbox,
        eq(schema.branchPushSettlementOutbox.pushId, schema.branchPushOutboxUpdates.pushId),
      )
      .where(eq(schema.branchPushSettlementOutbox.documentId, BETA_ID));
    expect(betaJoins.map(({ sourceKind }) => sourceKind)).toContain("journal");
    expect(new Set(harness.liveRoomBroadcasts().slice(broadcastsBefore))).toEqual(new Set(BATCH));
    expect(effects).toEqual(["step 1 started with 3 warm rooms", "step 1 failed", "step 2 ran"]);
    for (const documentId of BATCH) {
      await expect(harness.liveMarkdown(documentId)).resolves.toBe("Survivor.\n");
    }
    // Every drained branch is rebased onto live; the competed one keeps its new row.
    expect(result.items.map((item) => ("branchReset" in item ? item.branchReset : null))).toEqual([
      { branchId: gamma, fromGeneration: generations[0] },
      { branchId: alpha, fromGeneration: generations[1] },
      null,
    ]);
    expect(await Promise.all(request.map((id) => harness.branchGeneration(id)))).toEqual([
      (generations[0] as number) + 1,
      (generations[1] as number) + 1,
      generations[2],
    ]);
    for (const branchId of [gamma, alpha]) {
      const [branch] = await db
        .select({ state: schema.documentBranches.state })
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.id, branchId));
      expect(markdownFromUpdate(branch?.state ?? new Uint8Array())).toBe("Survivor.\n");
    }
    const betaRows = await db
      .select({ status: schema.branchWriteJournal.status })
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.branchId, beta));
    expect(betaRows.filter(({ status }) => status === "active")).toHaveLength(1);
    competitor.destroyWarmState();
    harness.destroyWarmState();
  });

  it.each([
    "after the durable batch commit",
    "after the second admission",
  ] as const)("a batch that fails %s leaves live untouched; one of two recoverers settles it whole", async (fault) => {
    const failing = createHarness(db, {
      ...(fault === "after the durable batch commit"
        ? {
            afterDurableCommit: async () => {
              throw new Error("injected process death after the batch commit");
            },
          }
        : {
            afterAdmission: ({ ordinal }: { ordinal: number }) => {
              if (ordinal === 2) throw new Error("injected failure after the second admission");
            },
          }),
    });
    const branchIds = await seedBatch(failing);
    const liveBefore = await liveDurableState(db, BATCH);
    const markdownBefore = await Promise.all(BATCH.map((id) => failing.liveMarkdown(id)));
    const broadcastsBefore = failing.liveRoomBroadcasts().length;

    await expect(failing.pushBranches(branchIds)).rejects.toThrow("injected");

    expect(await liveDurableState(db, BATCH)).toEqual(liveBefore);
    expect(failing.liveRoomBroadcasts().slice(broadcastsBefore)).toEqual([]);
    await expect(Promise.all(BATCH.map((id) => failing.liveMarkdown(id)))).resolves.toEqual(
      markdownBefore,
    );
    expect((await settlementStates(db, BATCH)).map(({ state }) => state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    failing.destroyWarmState();

    await expireAllPendingClaims(db);
    const recoverers = [createHarness(db), createHarness(db)];
    await expect(
      runInRootDrizzleTransaction(db, () => recoverers[0]!.recoverPendingLiveSettlements()),
    ).rejects.toThrow(/root-owned/);
    const recovered = await Promise.all(
      recoverers.map((recoverer) => recoverer.recoverPendingLiveSettlements()),
    );

    expect([...recovered].sort()).toEqual([0, 1]);
    expect((await settlementStates(db, BATCH)).map(({ state }) => state)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    const settled = await liveDurableState(db, BATCH);
    for (const [index, document] of settled.entries()) {
      const before = liveBefore[index] as (typeof liveBefore)[number];
      expect(document.updates.slice(before.updates.length).at(-1)).toBe("reconcile");
      expect(document.updates.filter((origin) => origin === "reconcile")).toHaveLength(1);
    }
    for (const recoverer of recoverers) recoverer.destroyWarmState();
    const reader = createHarness(db);
    for (const documentId of BATCH) {
      await expect(reader.liveMarkdown(documentId)).resolves.toBe("Survivor.\n");
    }
    reader.destroyWarmState();
  });

  /** Every branch's journal rows by status, so "reviewable" is checkable. */
  async function journalStatuses(branchIds: readonly string[]) {
    const rows = await db
      .select({
        branchId: schema.branchWriteJournal.branchId,
        status: schema.branchWriteJournal.status,
      })
      .from(schema.branchWriteJournal);
    return branchIds.map((branchId) =>
      rows.filter((row) => row.branchId === branchId).map(({ status }) => status),
    );
  }

  /** Trail changes and unconsumed notices that still name a push. */
  async function pushTraces() {
    const details = await db.select().from(schema.changeTrailDocumentDetails);
    const notices = await db.select().from(schema.pendingNotices);
    return {
      trailDocuments: details
        .filter((detail) => (detail.changes as unknown[]).length > 0)
        .map(({ documentId }) => documentId)
        .sort(),
      noticePushIds: notices.flatMap(({ data }) => (data.pushId ? [String(data.pushId)] : [])),
    };
  }

  it("a refusal abandons the staged batch in completion's own transaction, or not at all", async () => {
    const reason = { code: "stale", detail: { itemKeys: ["alpha"] } };
    const deferred: string[] = [];
    const workPublication = createWorkProjectionMutation({
      db,
      availability: {
        async advance() {
          deferred.push("availability");
          return "0";
        },
        async reserve() {
          throw new Error("unused");
        },
        async publishReserved() {
          throw new Error("unused");
        },
      },
      catalog: {
        async upsertWorkAuthorities() {
          deferred.push("catalog");
        },
        async refreshProject() {
          throw new Error("unused");
        },
      },
    });
    const [draft] = await db
      .insert(schema.drafts)
      .values({ projectId: PROJECT_ID, createdBy: USER_ID })
      .returning({ id: schema.drafts.id });
    const draftId = draft?.id as string;
    const marker = "00000000-0000-4000-8000-000000000f01";
    const proceedingStep = {
      kind: "test_write",
      async plan() {
        return {
          workIds: [WORK_ID],
          draftIds: [draftId],
          namespaceSourceIds: [SOURCE_ID],
          documentIds: [...BATCH],
          async beforeAdmission() {
            await currentDrizzleDb(db)
              .insert(schema.drafts)
              .values({ projectId: PROJECT_ID, createdBy: USER_ID, id: marker });
            runAfterDrizzleCommit(() => {
              deferred.push("commit");
            });
            await workPublication.publishWorks([WORK_ID]);
            return { kind: "proceed" as const };
          },
        };
      },
    };
    const assertRolledBack = async () => {
      expect((await db.select().from(schema.drafts)).filter(({ id }) => id === marker)).toEqual([]);
      expect(deferred).toEqual([]);
    };
    const locksSeen: boolean[][] = [];
    const rowLocked = (table: "works" | "drafts", id: string) =>
      runOutsideDrizzleTransaction(() =>
        db.execute(sql`select id from ${sql.identifier(table)} where id = ${id} for update nowait`),
      ).then(
        () => false,
        (cause: { code?: string; cause?: { code?: string } }) =>
          (cause.cause?.code ?? cause.code) === "55P03",
      );
    const refusingStep = {
      kind: "test_gate",
      async plan() {
        return {
          namespaceSourceIds: [SOURCE_ID],
          async beforeAdmission() {
            return { kind: "refuse" as const, reason };
          },
        };
      },
    };
    // First the lease expires during retirement; then a failure lands between the
    // rollback of the tentative publication and the abandonment.
    let withdrawalFault: "expire" | "fail" | null = "expire";
    let expired = false;
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness(db, {
      async duringWithdrawal() {
        const rowLocks = [await rowLocked("works", WORK_ID), await rowLocked("drafts", draftId)];
        const advisory = await runOutsideDrizzleTransaction(() =>
          db.execute(sql`
          select pg_try_advisory_xact_lock(hashtextextended(key, 0::bigint)) as acquired
          from unnest(ARRAY[${sql.join(
            [
              `context-project:${PROJECT_ID}:none:manuscript`,
              ...BATCH.map((id) => `document-mutation:${id}`),
            ].map((key) => sql`${key}`),
            sql`, `,
          )}]::text[]) as keys(key)
        `),
        );
        locksSeen.push([...rowLocks, ...advisory.map((row) => !row.acquired)]);
        const fault = withdrawalFault;
        withdrawalFault = null;
        if (fault === "expire") {
          expired = true;
          await harness.expireLeaseInTransaction();
        }
        if (fault === "fail") throw new Error("injected failure before abandonment");
      },
      publicationSteps: [proceedingStep, refusingStep],
    });
    const branchIds = await seedBatch(harness);
    const liveBefore = await liveDurableState(db, BATCH);
    const broadcastsBefore = harness.liveRoomBroadcasts().length;
    const batchStates = async () =>
      (await db.select().from(schema.branchPushSettlementBatches))
        .map(({ state, lastErrorCode, claimToken }) => ({ state, lastErrorCode, claimToken }))
        .sort((left, right) => left.state.localeCompare(right.state));

    const result = await harness.pushBranches(branchIds);

    // The expiry rolled the whole attempt back; the next attempt abandoned the batch.
    expect(expired).toBe(true);
    await assertRolledBack();
    expect(locksSeen).toEqual([Array(6).fill(true), Array(6).fill(true)]);
    expect(result.refused).toEqual(reason);
    expect(result.items).toEqual(
      BATCH.map((documentId, index) => ({
        status: "refused",
        branchId: branchIds[index],
        documentId,
        reason,
      })),
    );
    expect(await batchStates()).toEqual([
      { state: "abandoned", lastErrorCode: "stale", claimToken: null },
    ]);
    expect(await liveDurableState(db, BATCH)).toEqual(liveBefore);
    expect(harness.liveRoomBroadcasts().slice(broadcastsBefore)).toEqual([]);
    expect((await journalStatuses(branchIds)).flat()).toEqual(["active", "active", "active"]);
    expect(await db.select().from(schema.pushLineage)).toEqual([]);
    expect(await db.select().from(schema.branchPushSettlementOutbox)).toEqual([]);
    expect(await pushTraces()).toEqual({ trailDocuments: [], noticePushIds: [] });

    // Applied again, a failure before abandonment leaves the staged batch whole: no
    // withdrawal without its terminal state.
    withdrawalFault = "fail";
    await expect(harness.pushBranches(branchIds)).rejects.toThrow("injected failure before");
    expect(await batchStates()).toEqual([
      { state: "abandoned", lastErrorCode: "stale", claimToken: null },
      { state: "pending", lastErrorCode: null, claimToken: expect.any(String) },
    ]);
    expect((await journalStatuses(branchIds)).flat()).toEqual(["pushed", "pushed", "pushed"]);
    expect(await db.select().from(schema.pushLineage)).toHaveLength(3);
    expect(await liveDurableState(db, BATCH)).toEqual(liveBefore);
    await assertRolledBack();
    expect(locksSeen.at(-1)).toEqual(Array(6).fill(true));
    harness.destroyWarmState();

    // The next owner decides again and abandons it whole; recovery never returns to it.
    await expireAllPendingClaims(db);
    const recoverer = createHarness(db, { publicationSteps: [proceedingStep, refusingStep] });
    await expect(recoverer.recoverPendingLiveSettlements()).resolves.toBe(1);
    expect((await batchStates()).map(({ state }) => state)).toEqual(["abandoned", "abandoned"]);
    expect((await journalStatuses(branchIds)).flat()).toEqual(["active", "active", "active"]);
    expect(await db.select().from(schema.pushLineage)).toEqual([]);
    await expireAllPendingClaims(db);
    await expect(recoverer.recoverPendingLiveSettlements()).resolves.toBe(0);
    await assertRolledBack();
    recoverer.destroyWarmState();
  });

  it("held items stay held: a pre-staging hold survives its blocker leaving, completion holds more, the rest admit", async () => {
    const pathTaken = (path: string) => ({ code: "path_taken", detail: { path } });
    // Live conflicts as the step would compute them: beta and the cover image are blocked
    // at the check; the blockers leave before completion, where gamma is newly blocked.
    let blocked: Record<string, string> = { beta: BETA_ID, cover: "" };
    const completionItems: unknown[] = [];
    const admittedSeen: DocumentId[][] = [];
    const fingerprintsSeen: number[] = [];
    let betaFingerprintAtCheck: string | undefined;
    const draftLockSeen: boolean[] = [];
    const [draft] = await db
      .insert(schema.drafts)
      .values({ projectId: PROJECT_ID, createdBy: USER_ID })
      .returning({ id: schema.drafts.id });
    const draftId = draft?.id as string;
    // Another connection can't take the draft row while check or completion holds it.
    const draftLocked = () =>
      runOutsideDrizzleTransaction(() =>
        db.execute(sql`select id from drafts where id = ${draftId} for update nowait`),
      ).then(
        () => false,
        (cause: { code?: string; cause?: { code?: string } }) =>
          (cause.cause?.code ?? cause.code) === "55P03",
      );
    const holdsFor = (items: readonly string[]) =>
      items
        .filter((item) => item in blocked)
        .map((item) => ({
          itemKey: item,
          ...(blocked[item] ? { documentId: blocked[item] as DocumentId } : {}),
          reason: pathTaken(`${item}.md`),
        }));
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness(db, {
      afterDurableCommit: async () => {
        blocked = { gamma: GAMMA_ID };
      },
      publicationSteps: [
        {
          kind: "test_tree",
          async plan(scope) {
            fingerprintsSeen.push(scope.liveTextFingerprints.size);
            if (scope.stage === "check")
              betaFingerprintAtCheck = scope.liveTextFingerprints.get(BETA_ID);
            const { items } = scope.payloads.get("test_tree") as { items: string[] };
            return {
              draftIds: [draftId],
              documentIds: [BETA_ID],
              async check() {
                draftLockSeen.push(await draftLocked());
                const hold = holdsFor(items);
                const held = new Set(hold.map(({ itemKey }) => itemKey));
                return {
                  kind: "proceed" as const,
                  hold,
                  payload: { items: items.filter((item) => !held.has(item)) },
                };
              },
              async beforeAdmission() {
                draftLockSeen.push(await draftLocked());
                completionItems.push([...items]);
                return { kind: "proceed" as const, hold: holdsFor(items) };
              },
              async afterAdmission(admitted) {
                admittedSeen.push([...admitted]);
              },
            };
          },
        },
      ],
    });
    const [alpha, beta, gamma] = (await seedBatch(harness)) as [string, string, string];
    const generations = await Promise.all(
      [alpha, beta, gamma].map((id) => harness.branchGeneration(id)),
    );
    const heldBefore = await liveDurableState(db, [BETA_ID, GAMMA_ID]);
    const heldMarkdown = await Promise.all(
      [BETA_ID, GAMMA_ID].map((id) => harness.liveMarkdown(id)),
    );
    const broadcastsBefore = harness.liveRoomBroadcasts().length;
    // A text token is the full state: deletions count.
    const betaFingerprint = await harness.liveFingerprint(BETA_ID);

    const result = await harness.pushBranches([alpha, beta, gamma], "auto", {
      test_tree: { items: ["alpha", "beta", "gamma", "cover"] },
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        status: "pushed",
        push: expect.objectContaining({ branchId: alpha }),
      }),
      { status: "held", branchId: beta, documentId: BETA_ID, reason: pathTaken("beta.md") },
      { status: "held", branchId: gamma, documentId: GAMMA_ID, reason: pathTaken("gamma.md") },
    ]);
    expect(result.heldItems).toEqual([
      { itemKey: "beta", documentId: BETA_ID, reason: pathTaken("beta.md") },
      { itemKey: "cover", reason: pathTaken("cover.md") },
      { itemKey: "gamma", documentId: GAMMA_ID, reason: pathTaken("gamma.md") },
    ]);
    // The staged payload is the refined one: completion never sees an excluded item.
    expect(completionItems).toEqual([["alpha", "gamma"]]);
    expect(await db.select().from(schema.branchPushSettlementPayloads)).toEqual([
      expect.objectContaining({ stepKind: "test_tree", payload: { items: ["alpha", "gamma"] } }),
    ]);
    expect(
      (await db.select().from(schema.branchPushSettlementHolds))
        .map(({ itemKey, decidedIn }) => `${itemKey}:${decidedIn}`)
        .sort(),
    ).toEqual(["beta:check", "cover:check", "gamma:completion"]);
    expect(admittedSeen).toEqual([[ALPHA_ID]]);
    expect(fingerprintsSeen).toEqual([3, 2]);
    expect(betaFingerprintAtCheck).toBe(betaFingerprint);
    expect(draftLockSeen).toEqual([true, true]);
    expect(await liveDurableState(db, [BETA_ID, GAMMA_ID])).toEqual(heldBefore);
    await expect(
      Promise.all([BETA_ID, GAMMA_ID].map((id) => harness.liveMarkdown(id))),
    ).resolves.toEqual(heldMarkdown);
    expect(new Set(harness.liveRoomBroadcasts().slice(broadcastsBefore))).toEqual(
      new Set([ALPHA_ID]),
    );
    await expect(harness.liveMarkdown(ALPHA_ID)).resolves.toBe("Survivor.\n");
    expect((await journalStatuses([beta, gamma])).flat()).toEqual(["active", "active"]);
    expect(
      (await db.select().from(schema.pushLineage)).map(({ documentId }) => documentId),
    ).toEqual([ALPHA_ID]);
    expect((await pushTraces()).trailDocuments).toEqual([ALPHA_ID]);
    expect(
      await Promise.all([alpha, beta, gamma].map((id) => harness.branchGeneration(id))),
    ).toEqual([(generations[0] as number) + 1, generations[1], generations[2]]);
    // A second batch crashes after staging. The check's text hold and refined
    // payload must reconstruct under another owner, even after the blocker leaves.
    const peer = await harness.stagePeerReply(BETA_ID, "held-cold-peer");
    const peerBefore = await harness.stagedReplyMarkdown("held-cold-peer", BETA_ID, peer);
    expect(peerBefore).toContain("Outstanding peer reply.");
    const betaBefore = await harness.branchMarkdown(beta);
    const coldSeen: unknown[] = [];
    const coldStep = {
      kind: "test_cold_text",
      async prepare() {
        return { branchIds: [peer] };
      },
      async plan(scope: SettlementBatchScope) {
        const payload = scope.payloads.get("test_cold_text");
        return {
          async check() {
            return {
              kind: "proceed" as const,
              hold: [{ itemKey: "beta", documentId: BETA_ID, reason: pathTaken("beta.md") }],
              payload: { items: ["gamma"] },
            };
          },
          async beforeAdmission() {
            coldSeen.push({ payload, held: scope.stage === "completion" ? scope.held : [] });
            return { kind: "proceed" as const };
          },
          async afterAdmission(admitted: readonly DocumentId[]) {
            coldSeen.push([...admitted]);
          },
        };
      },
    };
    const crashing = createHarness(db, {
      publicationSteps: [coldStep],
      async afterDurableCommit() {
        throw new Error("cold text handoff");
      },
    });
    await expect(
      crashing.pushBranches([beta, gamma], "auto", {
        test_cold_text: { items: ["beta", "gamma"] },
      }),
    ).rejects.toThrow("cold text handoff");
    crashing.destroyWarmState();
    expect(coldSeen).toEqual([]);
    expect(await db.select().from(schema.branchPushSettlementPayloads)).toContainEqual(
      expect.objectContaining({ stepKind: "test_cold_text", payload: { items: ["gamma"] } }),
    );
    expect(await db.select().from(schema.branchPushSettlementHolds)).toContainEqual(
      expect.objectContaining({ itemKey: "beta", documentId: BETA_ID, decidedIn: "check" }),
    );
    await expireAllPendingClaims(db);
    const cold = createHarness(db, { publicationSteps: [coldStep] });
    const betaWarmBeforeRecovery = await cold.liveMarkdown(BETA_ID);
    const recoveryBroadcastsBefore = cold.liveRoomBroadcasts().length;
    await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
    expect(coldSeen).toEqual([
      {
        payload: { items: ["gamma"] },
        held: [{ itemKey: "beta", documentId: BETA_ID, reason: pathTaken("beta.md") }],
      },
      [GAMMA_ID],
    ]);
    expect(await liveDurableState(db, [BETA_ID])).toEqual(heldBefore.slice(0, 1));
    expect(await cold.branchMarkdown(beta)).toBe(betaBefore);
    expect(await harness.stagedReplyMarkdown("held-cold-peer", BETA_ID, peer)).toBe(peerBefore);
    expect(await cold.branchGeneration(beta)).toBe(generations[1]);
    expect((await journalStatuses([beta])).flat()).toEqual(["active"]);
    expect((await pushTraces()).trailDocuments).toEqual([ALPHA_ID, GAMMA_ID].sort());
    expect(await cold.liveMarkdown(BETA_ID)).toBe(betaWarmBeforeRecovery);
    expect(cold.liveRoomBroadcasts().slice(recoveryBroadcastsBefore)).not.toContain(BETA_ID);
    expect(
      (await db.select().from(schema.pushLineage)).map(({ documentId }) => documentId).sort(),
    ).toEqual([ALPHA_ID, GAMMA_ID].sort());
    cold.destroyWarmState();
    harness.destroyWarmState();
  });

  it("a payload-only batch hands off when its lease set grows; another owner recovers its refined payload and holds", async () => {
    const seeding = createHarness(db);
    const alphaBranch = await seeding.stagePeerReply(ALPHA_ID, "payload-lease");
    const betaBranch = await seeding.stagePeerReply(BETA_ID, "payload-lease-grown");
    const journalBefore = await db.select().from(schema.branchWriteJournal);
    seeding.destroyWarmState();
    const posterHeld = { itemKey: "poster", reason: { code: "path_taken" } };
    const payload = { items: ["cover", "poster"], leases: [alphaBranch] };
    const refined = { items: ["cover"], leases: [alphaBranch] };
    // The step's lease set grows between staging and completion (lane E: a new branch of D).
    let grown = false;
    const leased = (harness: ReturnType<typeof createHarness>, branchId: string) =>
      harness.criticalSections.withBranches([branchId], async () => false).catch(() => true);
    const imageStep = (seen: unknown[], harness: () => ReturnType<typeof createHarness>) => ({
      kind: "test_image",
      async prepare(staged: unknown) {
        return {
          branchIds: [...(staged as typeof payload).leases, ...(grown ? [betaBranch] : [])],
        };
      },
      async plan(scope: SettlementBatchScope) {
        const staged = scope.payloads.get("test_image") as typeof payload | undefined;
        if (staged === undefined) return null;
        return {
          namespaceSourceIds: [SOURCE_ID],
          async check() {
            return {
              kind: "proceed" as const,
              hold: [posterHeld],
              payload: { ...staged, items: staged.items.filter((item) => item !== "poster") },
            };
          },
          async afterAdmission(admitted: readonly DocumentId[]) {
            seen.push({
              staged,
              held: scope.stage === "completion" ? scope.held : null,
              admitted: [...admitted],
              leased: [await leased(harness(), alphaBranch), await leased(harness(), betaBranch)],
            });
          },
        };
      },
    });
    const seenWarm: unknown[] = [];
    let warmLeased: boolean | undefined;
    let warm!: ReturnType<typeof createHarness>;
    warm = createHarness(db, {
      afterDurableCommit: async () => {
        warmLeased = await leased(warm, alphaBranch);
        grown = true;
      },
      publicationSteps: [imageStep(seenWarm, () => warm)],
    });
    expect(await warm.stagePeerReply(ALPHA_ID, "payload-outstanding")).toBe(alphaBranch);
    const stagedPeerBefore = await warm.stagedReplyMarkdown(
      "payload-outstanding",
      ALPHA_ID,
      alphaBranch,
    );
    expect(stagedPeerBefore).toContain("Outstanding peer reply.");
    await expect(warm.pushBranches([], undefined, { test_image: payload })).rejects.toThrow(
      "needs branch leases its caller doesn't hold",
    );
    expect({ seenWarm, warmLeased }).toEqual({ seenWarm: [], warmLeased: true });
    // Handed off: pending, unclaimed, with the refined payload and the check's hold staged.
    expect(await db.select().from(schema.branchPushSettlementBatches)).toEqual([
      expect.objectContaining({ state: "pending", claimToken: null, attemptCount: 1 }),
    ]);
    expect(await db.select().from(schema.branchPushSettlementPayloads)).toEqual([
      expect.objectContaining({ stepKind: "test_image", payload: refined }),
    ]);
    expect(await db.select().from(schema.branchPushSettlementHolds)).toEqual([
      expect.objectContaining({ itemKey: "poster", decidedIn: "check" }),
    ]);
    expect(await db.select().from(schema.branchPushSettlementOutbox)).toEqual([]);
    expect(await warm.stagedReplyMarkdown("payload-outstanding", ALPHA_ID, alphaBranch)).toBe(
      stagedPeerBefore,
    );

    await expireAllPendingClaims(db);
    const seen: unknown[] = [];
    let recoverer!: ReturnType<typeof createHarness>;
    recoverer = createHarness(db, { publicationSteps: [imageStep(seen, () => recoverer)] });
    await expect(recoverer.recoverPendingLiveSettlements()).resolves.toBe(1);
    expect(seen).toEqual([
      { staged: refined, held: [posterHeld], admitted: [], leased: [true, true] },
    ]);
    expect(await db.select().from(schema.branchPushSettlementBatches)).toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
    expect(await warm.stagedReplyMarkdown("payload-outstanding", ALPHA_ID, alphaBranch)).toBe(
      stagedPeerBefore,
    );
    warm.destroyWarmState();
    expect(await db.select().from(schema.branchWriteJournal)).toEqual(journalBefore);
    recoverer.destroyWarmState();
  });

  it("the pre-staging check refuses before any row is written", async () => {
    let checks = 0;
    let beforeAdmissionRan = false;
    const harness = createHarness(db, {
      publicationSteps: [
        {
          kind: "test_check",
          async plan() {
            return {
              namespaceSourceIds: [SOURCE_ID],
              documentIds: [...BATCH],
              async check() {
                checks += 1;
                return { kind: "refuse" as const, reason: { code: "stale" } };
              },
              async beforeAdmission() {
                beforeAdmissionRan = true;
                return { kind: "proceed" as const };
              },
            };
          },
        },
      ],
    });
    const branchIds = await seedBatch(harness);
    const liveBefore = await liveDurableState(db, BATCH);

    const result = await harness.pushBranches(branchIds);

    expect(result.refused).toEqual({ code: "stale" });
    expect(result.items.map((item) => item.status)).toEqual(["refused", "refused", "refused"]);
    expect({ checks, beforeAdmissionRan }).toEqual({ checks: 1, beforeAdmissionRan: false });
    expect((await journalStatuses(branchIds)).flat()).toEqual(["active", "active", "active"]);
    for (const table of [
      schema.pushLineage,
      schema.branchPushSettlementBatches,
      schema.branchPushSettlementOutbox,
      schema.branchPushSettlementPayloads,
      schema.changeTrailDocumentDetails,
    ]) {
      expect(await db.select().from(table as typeof schema.pushLineage)).toEqual([]);
    }
    expect(await liveDurableState(db, BATCH)).toEqual(liveBefore);
    harness.destroyWarmState();
  });

  it("item 6: no stale or stalled claimant keeps, adopts or reuses ownership", async () => {
    const actorA = createHarness(db, {
      afterDurableCommit: async () => {
        throw new Error("pause actor A after durable claim");
      },
    });
    const branchId = await actorA.seedDestructivePush("item-6-stale-owner");
    await expect(actorA.push(branchId)).rejects.toThrow("pause actor A");
    const [ownedByA] = await db.select().from(schema.branchPushSettlementBatches);
    if (
      !ownedByA?.claimToken ||
      !ownedByA.claimKind ||
      !ownedByA.leaseExpiresAt ||
      !ownedByA.claimedAt
    ) {
      throw new Error("actor A claim was not persisted");
    }
    const staleClaim = {
      token: ownedByA.claimToken,
      epoch: Number(ownedByA.claimEpoch),
      kind: ownedByA.claimKind,
      leaseExpiresAt: ownedByA.leaseExpiresAt,
    };
    actorA.destroyWarmState();
    const contender = createHarness(db);
    await expect(contender.recoverPendingLiveSettlements()).resolves.toBe(0);
    contender.destroyWarmState();

    // A claimant that stalls between its claim UPDATE and its read never adopts its successor.
    const batchId = ownedByA.id;
    const rival = claimProbeStore(db);
    const rivalToken = "00000000-0000-4000-8000-000000000e04";
    let rivalClaim: Awaited<ReturnType<typeof rival.claimRecoverableBatch>> = null;
    await expirePendingClaims(db);
    const stalled = claimProbeStore(
      stallAfterFirstUpdate(db, schema.branchPushSettlementBatches, async () => {
        await expirePendingClaims(db);
        rivalClaim = await rival.claimRecoverableBatch({ batchId, token: rivalToken });
      }),
    );
    await expect(
      stalled.claimRecoverableBatch({ batchId, token: "00000000-0000-4000-8000-000000000e03" }),
    ).resolves.toBeNull();
    const heldByRival = (rivalClaim as Awaited<ReturnType<typeof rival.claimRecoverableBatch>>)
      ?.claim;
    if (!heldByRival) throw new Error("the rival did not claim the batch");
    // The same token reclaiming after backoff is a new owner: its old epoch is stale.
    await expect(
      rival.recordFailure({ batchId, claim: heldByRival, error: "backoff" }),
    ).resolves.toBe(true);
    await expirePendingClaims(db);
    const reclaimed = await rival.claimRecoverableBatch({ batchId, token: rivalToken });
    expect(reclaimed?.claim).toMatchObject({ token: rivalToken, epoch: heldByRival.epoch + 1 });
    await expect(rival.loadSettlementBatch({ batchId, owner: heldByRival })).resolves.toBeNull();
    await expect(rival.renewClaim({ batchId, claim: heldByRival })).resolves.toBeNull();
    await expirePendingClaims(db);

    let ambientCompletion: string | undefined;
    let staleProbe:
      | Awaited<ReturnType<ReturnType<typeof createHarness>["probeStaleSettlementClaim"]>>
      | undefined;
    let actorB!: ReturnType<typeof createHarness>;
    actorB = createHarness(db, {
      async afterClassification() {
        staleProbe ??= await actorB.probeStaleSettlementClaim(staleClaim);
        ambientCompletion ??= await actorB.attemptAmbientCompletion();
      },
    });
    await expect(actorB.recoverPendingLiveSettlements()).resolves.toBe(1);
    expect(staleProbe).toEqual({
      renewed: null,
      failureRecorded: false,
      completion: "retry",
      completionCallbackRan: false,
      afterCommitRan: false,
      liveRowsUnchanged: true,
    });
    // Completion itself, not only staging and recovery, refuses to join an ambient transaction.
    expect(ambientCompletion).toMatch(/root-owned/);
    expect(await db.select().from(schema.branchPushSettlementBatches)).toEqual([
      expect.objectContaining({ state: "completed", claimToken: null }),
    ]);
    expect(actorB.liveRoomBroadcasts()).not.toEqual([]);
    actorB.destroyWarmState();
  });

  it("F1a: preserves the true lock cut while joining post-cut writer updates after a killed process", async () => {
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const injectPostCutWriter = async (input: {
      documentIds: readonly DocumentId[];
      appendWriterPrefix(documentId: DocumentId, prefix: string): Promise<void>;
    }) => {
      expect(input.documentIds).toHaveLength(1);
      await input.appendWriterPrefix(input.documentIds[0]!, "Writer post-cut: ");
    };

    const deleteAfterFirstClassification = () => {
      let joined = false;
      return async ({
        documentId,
        deleteWriterPrefix,
      }: {
        documentId: DocumentId;
        deleteWriterPrefix(documentId: DocumentId, length: number): Promise<void>;
      }) => {
        if (joined) return;
        joined = true;
        await deleteWriterPrefix(documentId, 1);
      };
    };
    const result = await settlementOracle({
      async runWarm() {
        const warm = createHarness(db, {
          afterDurableCommit: injectPostCutWriter,
          afterClassification: deleteAfterFirstClassification(),
        });
        const branchId = await warm.seedDestructivePush("oracle-f1a-warm");
        await expect(warm.push(branchId)).resolves.toMatchObject({ status: "pushed" });
        await expectLiveSweepOnly(warm);
        const observed = await observeSettlement(db, warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        coldHarness = createHarness(db, {
          ids: COLD_SCENARIO_IDS,
          afterDurableCommit: async (input) => {
            await injectPostCutWriter(input);
            throw new Error("injected process death after durable push commit");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-f1a-cold");
        await expect(coldHarness.push(branchId)).rejects.toThrow("injected process death");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims(db, COLD_SCENARIO_IDS.ALPHA_ID);
        const cold = createHarness(db, {
          ids: COLD_SCENARIO_IDS,
          afterClassification: deleteAfterFirstClassification(),
        });
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        await expectLiveSweepOnly(cold);
        const observed = await observeSettlement(db, cold, COLD_SCENARIO_IDS.ALPHA_ID);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Writer recent: Writer captured body."),
    ]);
    expect(appliedMarkdown(result.cold)).toBe("Survivor.\n");
    expect(result.cold.completionState).toEqual({ state: "completed", joinVersion: 2 });
    const [completed] = await db
      .select()
      .from(schema.branchPushSettlementOutbox)
      .where(eq(schema.branchPushSettlementOutbox.documentId, COLD_SCENARIO_IDS.ALPHA_ID));
    const postCut = await db
      .select()
      .from(schema.branchPushOutboxUpdates)
      .where(eq(schema.branchPushOutboxUpdates.pushId, completed?.pushId));
    expect(markdownFromUpdate(completed?.lockCutUpdate ?? new Uint8Array())).toContain(
      "Writer recent: Writer captured body.",
    );
    expect(markdownFromUpdate(completed?.lockCutUpdate ?? new Uint8Array())).not.toContain(
      "Writer post-cut:",
    );
    expect(postCut).toHaveLength(2);
    expect(postCut).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKind: "journal", update: expect.any(Uint8Array) }),
      ]),
    );
  });

  it("item 13: unresolved settlement joins survive a commit fault and block snapshot replacement", async () => {
    let warm: ReturnType<typeof createHarness>;
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const result = await settlementOracle({
      async runWarm() {
        warm = createHarness(db, {
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await expect(warm.attemptSnapshotReplacement()).resolves.toEqual({
              ok: false,
              code: "authority_head_busy",
            });
            await appendWriterPrefix(ALPHA_ID, "Racing writer: ");
          },
        });
        const branchId = await warm.seedDestructivePush("oracle-race-fault-warm");
        await expect(warm.push(branchId)).resolves.toMatchObject({ status: "pushed" });
        const observed = await observeSettlement(db, warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        coldHarness = createHarness(db, {
          ids: COLD_SCENARIO_IDS,
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await expect(coldHarness?.attemptSnapshotReplacement()).resolves.toEqual({
              ok: false,
              code: "authority_head_busy",
            });
            await appendWriterPrefix(COLD_SCENARIO_IDS.ALPHA_ID, "Racing writer: ");
            throw new Error("fault after journal commit and settlement staging");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-race-fault-cold");
        await expect(coldHarness.push(branchId)).rejects.toThrow("fault after journal commit");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims(db, COLD_SCENARIO_IDS.ALPHA_ID);
        const failingCompletion = createHarness(db, {
          ids: COLD_SCENARIO_IDS,
          beforeCompletionCommit() {
            throw new Error("completion transaction failed after live apply");
          },
        });
        await expect(failingCompletion.recoverPendingLiveSettlements()).resolves.toBe(0);
        await expect(settlementStates(db, [COLD_SCENARIO_IDS.ALPHA_ID])).resolves.toEqual([
          expect.objectContaining({ state: "pending" }),
        ]);
        // The rolled-back completion never reached the warm room.
        await expect(failingCompletion.liveMarkdown(COLD_SCENARIO_IDS.ALPHA_ID)).resolves.toContain(
          "Writer captured body.",
        );
        failingCompletion.destroyWarmState();
        await expirePendingClaims(db, COLD_SCENARIO_IDS.ALPHA_ID);
        const cold = createHarness(db, { ids: COLD_SCENARIO_IDS });
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(db, cold, COLD_SCENARIO_IDS.ALPHA_ID);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Writer recent: Writer captured body."),
    ]);
    expect(appliedMarkdown(result.cold)).toBe("Survivor.\n");
  });
});
