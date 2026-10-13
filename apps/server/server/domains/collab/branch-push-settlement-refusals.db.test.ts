/** PostgreSQL proofs of what a batch does when it can't settle whole: refusals, holds, hand-offs and the pre-staging check. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentDrizzleDb, runAfterDrizzleCommit } from "../../shared/drizzle-transaction.js";
import { createWorkProjectionMutation } from "../projects/adapters/work-projection-mutation.js";
import type { SettlementBatchScope } from "./domain/ports/settlement-publication.js";
import {
  ALPHA_ID,
  SETTLEMENT_BATCH as BATCH,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  expireAllPendingClaims,
  GAMMA_ID,
  liveDurableState,
  PROJECT_ID,
  resetSettlementFixture,
  SOURCE_ID,
  schema,
  seedSettlementBatch as seedBatch,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";
import {
  runOutsideDrizzleTransaction,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

describe("branch-push settlement refusals and holds (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetSettlementFixture(db));
  afterAll(() => closeDatabase(db));

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
    ).toEqual(generations);
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

  it("a payload-only batch hands off when its lease set keeps growing past the call's retries; another owner recovers its refined payload and holds", async () => {
    const seeding = createHarness(db);
    const alphaBranch = await seeding.stagePeerReply(ALPHA_ID, "payload-lease");
    const betaBranch = await seeding.stagePeerReply(BETA_ID, "payload-lease-grown");
    const journalBefore = await db.select().from(schema.branchWriteJournal);
    seeding.destroyWarmState();
    const posterHeld = { itemKey: "poster", reason: { code: "path_taken" } };
    const payload = { items: ["cover", "poster"], leases: [alphaBranch] };
    const refined = { items: ["cover"], leases: [alphaBranch] };
    // The step's lease set grows between staging and completion (lane E: a new branch of D),
    // and keeps growing on every completion of the warm call, so the call continues its
    // batch under each grown set (F22) until its retries run out and recovery takes it.
    let grown = false;
    let growing = false;
    let growth = 0;
    const leased = (harness: ReturnType<typeof createHarness>, branchId: string) =>
      harness.criticalSections.withBranches([branchId], async () => false).catch(() => true);
    const imageStep = (seen: unknown[], harness: () => ReturnType<typeof createHarness>) => ({
      kind: "test_image",
      async prepare(staged: unknown) {
        if (growing) growth += 1;
        return {
          branchIds: [
            ...(staged as typeof payload).leases,
            ...(grown ? [betaBranch] : []),
            ...(growing ? [`grown-${growth}`] : []),
          ],
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
        growing = true;
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
    growing = false;
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
});
