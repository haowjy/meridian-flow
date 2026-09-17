/** PostgreSQL proof that admission and explicit retirement choose one serialized winner. */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadRunOwnership } from "../loop/thread-run-ownership.js";

function barrier() {
  let release!: () => void;
  let reached = false;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve() {
      reached = true;
      release();
    },
    wait: () => vi.waitFor(() => expect(reached).toBe(true), { timeout: 2000 }),
  };
}

const RUN = process.env.RUN_DB_TESTS === "1" && process.env.DATABASE_URL;
if (!RUN) {
  describe.skip("user turn admission ledger (postgres)", () => {});
} else {
  describe("user turn admission ledger (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../../threads/adapters/drizzle/repositories.js"
    );
    const { createDrizzleEventJournalReader } = await import(
      "../../threads/adapters/drizzle/event-reader.js"
    );
    const { createDrizzleEventJournalWriter } = await import(
      "../../threads/adapters/drizzle/event-writer.js"
    );
    const { createThreadEventHub } = await import("../../threads/thread-event-hub.js");
    const { createNoopEventSink } = await import("../../observability/index.js");
    const { createDrizzleUploadIntakeRepository } = await import(
      "../../context/uploads/drizzle-upload-intake.js"
    );
    const { createInMemoryCreditLedger } = await import("../../billing/index.js");
    const { createDrizzleAdmissionRecords } = await import("./drizzle-admission-records.js");
    const { createAdmissionTurnStarter } = await import("./admission-turn-starter.js");
    const { createUserTurnAdmission } = await import("./user-turn-admission.js");
    const { createInMemoryThreadRunOwnership } = await import("../loop/thread-run-ownership.js");
    const { createTurnRunner } = await import("../loop/turn-runner.js");
    const { createOrchestrator } = await import("../loop/orchestrator.js");
    const { createTestOrchestratorDeps } = await import(
      "../loop/__tests__/test-orchestrator-deps.js"
    );
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL disappeared after the DB test gate");
    const firstDb = createDb(url, { max: 2 });
    const secondDb = createDb(url, { max: 2 });
    const repos = createDrizzleRepositoriesForTest(firstDb);
    const records = createDrizzleAdmissionRecords(firstDb);
    const retireRecords = createDrizzleAdmissionRecords(secondDb);
    const USER = "00000000-0000-4000-8000-000000000f51";
    const PROJECT = "00000000-0000-4000-8000-000000000f52";
    const THREAD = "00000000-0000-4000-8000-000000000f53" as never;
    const ROLLBACK_THREAD = "00000000-0000-4000-8000-000000000f54" as never;
    const SOURCE = "00000000-0000-4000-8000-000000000f58" as never;
    const DOCUMENT = "00000000-0000-4000-8000-000000000f59" as never;
    const ROLLBACK_DOCUMENT = "00000000-0000-4000-8000-000000000f60" as never;

    beforeEach(async () => {
      await truncateDrizzleTables(firstDb, [schema.users]);
      await firstDb.insert(schema.users).values(conformanceUserValues(USER, "admission"));
      await firstDb
        .insert(schema.projects)
        .values({ id: PROJECT, userId: USER, name: "Admission", slug: "admission" });
      await firstDb.insert(schema.threads).values({
        id: THREAD,
        projectId: PROJECT,
        createdByUserId: USER,
        title: "",
        kind: "primary",
        status: "idle",
      });
    });
    afterAll(async () => {
      await firstDb.close();
      await secondDb.close();
    });

    async function seedUpload(documentId: string, suffix: string) {
      const uri = `uploads://@/map-${suffix}.png`;
      await firstDb.insert(schema.documents).values({
        id: documentId as never,
        contextSourceId: SOURCE,
        name: `map-${suffix}`,
        extension: "png",
        fileType: "png",
        mimeType: "image/png",
      });
      await firstDb.insert(schema.uploadIntakes).values({
        projectId: PROJECT,
        intakeId: `intake-${suffix}`,
        actorUserId: USER,
        contextSourceId: SOURCE,
        documentId: documentId as never,
        fingerprint: `upload-${suffix}`,
        byteDigest: "a".repeat(64),
        filename: `map-${suffix}.png`,
        mimeType: "image/png",
        finalPath: `map-${suffix}.png`,
        objectKey: `uploads/${PROJECT}/${documentId}`,
        fileType: "png",
        canonicalUri: uri,
        locationRevision: crypto.randomUUID(),
        state: "finalized",
      });
      return uri;
    }

    async function composeAdmission(input: {
      threadId: typeof THREAD;
      documentId: string;
      uri: string;
      failAfterProvenance?: boolean;
      runOwnership?: ThreadRunOwnership;
      beforeTurn?: () => Promise<void>;
      finishRun?: Promise<void>;
    }) {
      const runOwnership = input.runOwnership ?? createInMemoryThreadRunOwnership();
      const creditLedger = createInMemoryCreditLedger();
      await creditLedger.grant({
        userId: USER,
        source: "manual",
        amountMillicredits: "1000000",
        reason: "admission transaction proof",
      });
      const eventReader = createDrizzleEventJournalReader(firstDb);
      const hub = createThreadEventHub({
        journalWriter: createDrizzleEventJournalWriter(firstDb),
        journalReader: eventReader,
        eventSink: createNoopEventSink(),
      });
      const deps = createTestOrchestratorDeps({
        boundThreads: () => [input.threadId],
        repos,
        eventWriter: hub,
        creditLedger,
        gateway: {
          getDefaultModel() {
            return "blocked-test-model";
          },
          async *stream() {
            await (input.finishRun ?? new Promise(() => {}));
            throw new Error("fixture run finished");
          },
          async generate() {
            throw new Error("generate is not used");
          },
        },
      });
      const runner = createTurnRunner({
        runOwnership,
        orchestrator: createOrchestrator(deps),
        hub,
        repos: { turns: repos.turns },
        eventSink: deps.eventSink,
        workContextDelivery: {
          async beforeTurn() {
            await input.beforeTurn?.();
          },
          async flushOwned() {},
        },
      });
      const uploadIntake = createDrizzleUploadIntakeRepository(firstDb);
      return createUserTurnAdmission({
        runOwnership,
        records,
        availability: {
          async lookup() {
            return {
              projectId: PROJECT,
              resolutionId: "resolution",
              resolutions: [
                {
                  kind: "available",
                  documentId: input.documentId,
                  generation: "1",
                  authority: {
                    kind: "work",
                    projectId: PROJECT,
                    workId: "00000000-0000-4000-8000-000000000f70",
                    workSlug: null,
                  },
                  entry: {
                    kind: "file",
                    entryId: input.documentId,
                    uri: input.uri,
                    editable: false,
                    disposition: "binary",
                    fileType: "image",
                    mimeType: "image/png",
                    scope: {
                      kind: "work",
                      projectId: PROJECT,
                      workId: "00000000-0000-4000-8000-000000000f70",
                    },
                    sourceId: SOURCE,
                    parentId: SOURCE,
                    name: "map.png",
                    aliases: [],
                    path: ["map.png"],
                    provisionalName: false,
                  },
                },
              ],
            };
          },
        } as never,
        async threadProject() {
          return PROJECT;
        },
        async verifyDraftUpload() {
          return true;
        },
        starter: createAdmissionTurnStarter({
          runner,
          records,
          consumeUploads: (documentIds) => uploadIntake.consume(documentIds),
          async attachDocument(threadId, documentId, relationship) {
            const attached = await repos.threadDocuments.attach(
              threadId as never,
              documentId,
              relationship,
            );
            if (input.failAfterProvenance) throw new Error("rollback after provenance");
            return attached;
          },
        }),
      });
    }

    it("persists the actual sparse cursor for a one-text admission and replays it", async () => {
      const service = await composeAdmission({ threadId: THREAD, documentId: DOCUMENT, uri: "" });
      const request = {
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "one-text",
        text: "Opening",
        blocks: [{ type: "text" as const, text: "Opening" }],
        references: [],
      };

      await expect(service.admit(request)).resolves.toMatchObject({
        kind: "accepted",
        snapshotFloorNextSeq: "3001",
      });
      await expect(service.admit(request)).resolves.toMatchObject({
        kind: "already-accepted",
        snapshotFloorNextSeq: "3001",
      });
    });

    it("persists ordered occurrences, replays their actual sparse cursor, and rolls the whole accepted settlement back together", async () => {
      await firstDb.insert(schema.threads).values({
        id: ROLLBACK_THREAD,
        projectId: PROJECT,
        createdByUserId: USER,
        title: "",
        kind: "primary",
        status: "idle",
      });
      await firstDb.insert(schema.contextSources).values({
        id: SOURCE,
        projectId: PROJECT,
        name: "Uploads",
        slug: "uploads",
        scope: "project",
      });
      const uri = await seedUpload(DOCUMENT, "commit");
      const rollbackUri = await seedUpload(ROLLBACK_DOCUMENT, "rollback");
      const admission = (threadId: typeof THREAD, documentId: string, referenceUri: string) => ({
        actorUserId: USER as never,
        threadId,
        submissionId: `occurrences-${documentId}`,
        text: "Compare [[Gate Map]]\nwith [[Gate Map]]",
        blocks: [
          { type: "text" as const, text: "Compare " },
          { type: "reference" as const, text: "[[Gate Map]]", documentId, uri: referenceUri },
          { type: "image" as const, documentId, uri: referenceUri },
          { type: "text" as const, text: "\nwith " },
          { type: "reference" as const, text: "[[Gate Map]]", documentId, uri: referenceUri },
          { type: "image" as const, documentId, uri: referenceUri },
        ],
        references: [
          {
            documentId,
            uri: referenceUri,
            purpose: "draft-upload" as const,
            intakeId: `intake-${documentId === DOCUMENT ? "commit" : "rollback"}`,
          },
        ],
      });

      const service = await composeAdmission({ threadId: THREAD, documentId: DOCUMENT, uri });
      const request = admission(THREAD, DOCUMENT, uri);
      const accepted = await service.admit(request);
      expect(accepted).toMatchObject({ kind: "accepted", snapshotFloorNextSeq: "8001" });
      if (accepted.kind !== "accepted" && accepted.kind !== "already-accepted") {
        throw new Error("expected accepted admission");
      }
      const persisted = (await firstDb.select().from(schema.turnBlocks)).sort(
        (left, right) => left.sequence - right.sequence,
      );
      expect(persisted.map((block) => block.blockType)).toEqual([
        "text",
        "text",
        "image",
        "text",
        "text",
        "image",
      ]);
      expect(persisted.map((block) => block.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(persisted[1]).toMatchObject({
        blockType: "text",
        modelText: "[[Gate Map]]",
        content: {
          type: "reference",
          text: "[[Gate Map]]",
          documentId: DOCUMENT,
          uri,
        },
      });
      expect(persisted[4]).toMatchObject({
        blockType: "text",
        modelText: "[[Gate Map]]",
        content: {
          type: "reference",
          text: "[[Gate Map]]",
          documentId: DOCUMENT,
          uri,
        },
      });
      expect(persisted.filter((block) => block.blockType === "image")).toHaveLength(2);
      await expect(service.admit(request)).resolves.toMatchObject({
        kind: "already-accepted",
        snapshotFloorNextSeq: "8001",
      });
      await expect(
        service.admit({
          ...request,
          text: "Compare [[Moved Map]]\nwith [[Gate Map]]",
          blocks: request.blocks.map((block, index) =>
            index === 1 && block.type === "reference" ? { ...block, text: "[[Moved Map]]" } : block,
          ),
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(firstDb.select().from(schema.userTurnAdmissions)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ state: "accepted" })]),
      );
      await expect(firstDb.select().from(schema.threadDocuments)).resolves.toEqual([
        expect.objectContaining({
          threadId: THREAD,
          documentId: DOCUMENT,
          relationship: "created",
        }),
      ]);
      await expect(firstDb.select().from(schema.uploadIntakes)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentId: DOCUMENT, consumedAt: expect.any(Date) }),
        ]),
      );

      const rollbackService = await composeAdmission({
        threadId: ROLLBACK_THREAD,
        documentId: ROLLBACK_DOCUMENT,
        uri: rollbackUri,
        failAfterProvenance: true,
      });
      const rollbackRequest = admission(ROLLBACK_THREAD, ROLLBACK_DOCUMENT, rollbackUri);
      await expect(rollbackService.admit(rollbackRequest)).rejects.toThrow(
        "rollback after provenance",
      );
      const allTurns = await firstDb.select().from(schema.turns);
      expect(allTurns.filter((turn) => turn.threadId === ROLLBACK_THREAD)).toHaveLength(0);
      const allAdmissions = await firstDb.select().from(schema.userTurnAdmissions);
      expect(allAdmissions.find((row) => row.threadId === ROLLBACK_THREAD)).toMatchObject({
        state: "pending",
      });
      const uploads = await firstDb.select().from(schema.uploadIntakes);
      expect(uploads.find((row) => row.documentId === ROLLBACK_DOCUMENT)?.consumedAt).toBeNull();
      const provenance = await firstDb.select().from(schema.threadDocuments);
      expect(provenance.some((row) => row.threadId === ROLLBACK_THREAD)).toBe(false);
    });

    it("persists and replays a production-composed stale-token rejection", async () => {
      let orchestratorStarts = 0;
      const consumeUploads = vi.fn();
      const runner = createTurnRunner({
        orchestrator: {
          async runTurn() {
            orchestratorStarts += 1;
            throw new Error("a terminal identity re-entered turn effects");
          },
        } as never,
        hub: {} as never,
        repos: { turns: {} as never },
        eventSink: {} as never,
        workContextDelivery: {} as never,
      });
      const service = createUserTurnAdmission({
        runOwnership: createInMemoryThreadRunOwnership(),
        records,
        availability: {
          async lookup() {
            return { projectId: PROJECT, resolutionId: "resolution", resolutions: [] };
          },
        } as never,
        async threadProject() {
          return PROJECT;
        },
        starter: createAdmissionTurnStarter({
          runner,
          records,
          consumeUploads,
          attachDocument: vi.fn(),
        }),
      });
      const admission = {
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "stale-token-rejection",
        connectionToken: "not-registered",
        text: "writer text",
        blocks: [{ type: "text" as const, text: "writer text" }],
        references: [],
      };

      await expect(service.admit(admission)).resolves.toEqual({
        kind: "rejected",
        submissionId: admission.submissionId,
        code: "connection_token_not_live",
      });
      await expect(
        service.lookup({
          actorUserId: USER as never,
          threadId: THREAD,
          submissionId: admission.submissionId,
        }),
      ).resolves.toEqual({
        kind: "rejected",
        submissionId: admission.submissionId,
        code: "connection_token_not_live",
      });
      await expect(firstDb.select().from(schema.userTurnAdmissions)).resolves.toMatchObject([
        {
          threadId: THREAD,
          submissionId: admission.submissionId,
          actorUserId: USER,
          state: "rejected",
          rejectionCode: "connection_token_not_live",
        },
      ]);

      runner.registerLiveConnectionToken(admission.connectionToken);
      await expect(service.admit(admission)).resolves.toEqual({
        kind: "rejected",
        submissionId: admission.submissionId,
        code: "connection_token_not_live",
      });
      await expect(
        service.admit({
          ...admission,
          text: "different",
          blocks: [{ type: "text", text: "different" }],
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(orchestratorStarts).toBe(0);
      expect(consumeUploads).not.toHaveBeenCalled();
      await expect(firstDb.select().from(schema.turns)).resolves.toHaveLength(0);
    });

    it("lets exactly one same-identity contender reserve the pending row", async () => {
      const request = {
        threadId: THREAD,
        submissionId: "contended",
        actorUserId: USER,
        fingerprint: "same-fingerprint",
        claimExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
      };
      const results = await Promise.all([records.reserve(request), retireRecords.reserve(request)]);
      expect(results).toEqual(
        expect.arrayContaining([
          { kind: "reserved" },
          {
            kind: "winner",
            record: {
              state: "pending",
              fingerprint: "same-fingerprint",
              claimExpiresAt: request.claimExpiresAt,
            },
          },
        ]),
      );
      await expect(firstDb.select().from(schema.userTurnAdmissions)).resolves.toHaveLength(1);
    });

    it("returns the accepted winner when admission holds the turn-start lock first", async () => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const response = {
        kind: "accepted" as const,
        threadId: THREAD,
        submissionId: "submission",
        userTurnId: "00000000-0000-4000-8000-000000000f54" as never,
        assistantTurnId: "00000000-0000-4000-8000-000000000f55" as never,
        resumeAfterSeq: "0",
        snapshotFloorNextSeq: "4",
      };
      await records.reserve({
        threadId: THREAD,
        submissionId: response.submissionId,
        actorUserId: USER,
        fingerprint: "fingerprint",
        claimExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
      });
      const admission = repos.runTurnStartTransition(THREAD, null, async () => {
        locked();
        await barrier;
        return records.accept({ response, fingerprint: "fingerprint" });
      });
      await acquired;
      const retirement = retireRecords.retire({
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "submission",
      });
      release();
      await expect(admission).resolves.toMatchObject({ kind: "accepted" });
      await expect(retirement).resolves.toMatchObject({
        kind: "already-accepted",
        userTurnId: response.userTurnId,
      });
    });

    it("retirement of an unseen identity prevents delayed acceptance", async () => {
      await expect(
        retireRecords.retire({
          actorUserId: USER as never,
          threadId: THREAD,
          submissionId: "late",
        }),
      ).resolves.toMatchObject({ kind: "retired" });
      await repos.runTurnStartTransition(THREAD, null, async () => {
        const winner = await records.accept({
          response: {
            kind: "accepted",
            threadId: THREAD,
            submissionId: "late",
            userTurnId: "00000000-0000-4000-8000-000000000f56" as never,
            assistantTurnId: "00000000-0000-4000-8000-000000000f57" as never,
            resumeAfterSeq: "0",
            snapshotFloorNextSeq: "4",
          },
          fingerprint: "fingerprint",
        });
        expect(winner).toMatchObject({ kind: "winner", record: { state: "retired" } });
      });
    });

    it("keeps a claimed original live through expiry and accepts its one settlement", async () => {
      const { createDrizzleThreadRunOwnership } = await import(
        "../adapters/drizzle-thread-run-ownership.js"
      );
      const { eq } = await import("drizzle-orm");
      const originalOwnership = createDrizzleThreadRunOwnership(firstDb);
      const recoveryOwnership = createDrizzleThreadRunOwnership(secondDb);
      const claimed = barrier();
      const continueOriginal = barrier();
      const finishRun = barrier();
      const original = await composeAdmission({
        threadId: THREAD,
        documentId: DOCUMENT,
        uri: "",
        runOwnership: originalOwnership,
        beforeTurn: async () => {
          claimed.resolve();
          await continueOriginal.promise;
        },
        finishRun: finishRun.promise,
      });
      const recovery = createUserTurnAdmission({
        records: retireRecords,
        runOwnership: recoveryOwnership,
        availability: {
          async lookup() {
            throw new Error("unexpected reference resolution");
          },
        },
        async threadProject() {
          return PROJECT;
        },
        starter: {
          async start() {
            throw new Error("unexpected replay start");
          },
        },
      });
      const request = {
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "live-original",
        text: "original",
        blocks: [{ type: "text" as const, text: "original" }],
        references: [],
      };
      const admission = original.admit(request);
      try {
        await claimed.wait();
        await firstDb
          .update(schema.userTurnAdmissions)
          .set({ claimExpiresAt: new Date(0) })
          .where(eq(schema.userTurnAdmissions.threadId, THREAD));
        await expect(recovery.lookup(request)).resolves.toMatchObject({ kind: "pending" });
        continueOriginal.resolve();
        const accepted = await admission;
        expect(accepted.kind).toBe("accepted");
        await expect(recovery.admit(request)).resolves.toMatchObject({ kind: "already-accepted" });
        expect(await secondDb.select().from(schema.turns)).toHaveLength(2);
        expect(await secondDb.select().from(schema.userTurnAdmissions)).toMatchObject([
          { state: "accepted" },
        ]);
      } finally {
        continueOriginal.resolve();
        finishRun.resolve();
        await admission;
        await vi.waitFor(async () => {
          const released = await recoveryOwnership.tryAcquire(THREAD);
          expect(released).not.toBeNull();
          await released?.release();
        });
      }
    });

    it("holds recovery ownership through commit against a delayed original runner", async () => {
      const { createDrizzleThreadRunOwnership } = await import(
        "../adapters/drizzle-thread-run-ownership.js"
      );
      const { currentDrizzleDb, runInDrizzleTransaction } = await import(
        "../../../shared/drizzle-transaction.js"
      );
      const { eq } = await import("drizzle-orm");
      const recoveryOwnership = createDrizzleThreadRunOwnership(firstDb);
      const originalOwnership = createDrizzleThreadRunOwnership(secondDb);
      const reserved = barrier();
      const continueOriginal = barrier();
      const recoveryLocked = barrier();
      const commitRecovery = barrier();
      const rejectedStart = barrier();
      const originalRecords = {
        ...retireRecords,
        async reject(input: Parameters<typeof retireRecords.reject>[0]) {
          rejectedStart.resolve();
          return retireRecords.reject(input);
        },
      };
      let started = 0;
      const consumeUploads = vi.fn();
      const attachDocument = vi.fn();
      const runner = createTurnRunner({
        runOwnership: originalOwnership,
        orchestrator: {
          async runTurn() {
            started++;
            throw new Error("recovery lost its claim");
          },
          async finalizeGeneratorFailure() {
            throw new Error("unexpected generator failure");
          },
        },
        hub: createThreadEventHub({
          journalWriter: createDrizzleEventJournalWriter(secondDb),
          journalReader: createDrizzleEventJournalReader(secondDb),
          eventSink: createNoopEventSink(),
        }),
        repos: { turns: createDrizzleRepositoriesForTest(secondDb).turns },
        eventSink: createNoopEventSink(),
        workContextDelivery: { async beforeTurn() {}, async flushOwned() {} },
      });
      const original = createUserTurnAdmission({
        records: originalRecords,
        runOwnership: originalOwnership,
        availability: {
          async lookup() {
            reserved.resolve();
            await continueOriginal.promise;
            return { projectId: PROJECT, resolutionId: "race", resolutions: [] };
          },
        } as never,
        async threadProject() {
          return PROJECT;
        },
        starter: createAdmissionTurnStarter({
          runner,
          records: originalRecords,
          consumeUploads,
          attachDocument,
        }),
        now: () => new Date(0),
      });
      const recovery = createUserTurnAdmission({
        records: {
          ...records,
          async recoverExpiredPending(input) {
            return runInDrizzleTransaction(firstDb, async () => {
              await currentDrizzleDb(firstDb)
                .select()
                .from(schema.threads)
                .where(eq(schema.threads.id, THREAD))
                .for("update");
              recoveryLocked.resolve();
              await commitRecovery.promise;
              return records.recoverExpiredPending(input);
            });
          },
        },
        runOwnership: recoveryOwnership,
        availability: {
          async lookup() {
            throw new Error("unexpected resolution");
          },
        },
        async threadProject() {
          return PROJECT;
        },
        starter: {
          async start() {
            throw new Error("unexpected start");
          },
        },
      });
      const request = {
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "delayed-original",
        text: "original",
        blocks: [{ type: "text" as const, text: "original" }],
        references: [],
      };
      const admission = original.admit(request).then(
        (result) => result,
        (error: unknown) => error,
      );
      await reserved.wait();
      const recovering = recovery.lookup(request);
      try {
        await recoveryLocked.wait();
        continueOriginal.resolve();
        await rejectedStart.wait();
        commitRecovery.resolve();
        await expect(recovering).resolves.toMatchObject({
          kind: "rejected",
          code: "recovery_no_committed_turn",
        });
        await expect(admission).resolves.toMatchObject({
          kind: "rejected",
          code: "recovery_no_committed_turn",
        });
        expect(started).toBe(0);
        expect(consumeUploads).not.toHaveBeenCalled();
        expect(attachDocument).not.toHaveBeenCalled();
        expect(await firstDb.select().from(schema.turns)).toHaveLength(0);
        expect(await firstDb.select().from(schema.eventJournal)).toHaveLength(0);
        const released = await originalOwnership.tryAcquire(THREAD);
        expect(released).not.toBeNull();
        await released?.release();
      } finally {
        continueOriginal.resolve();
        commitRecovery.resolve();
        await Promise.allSettled([admission, recovering]);
      }
    });

    it.each([
      "lookup",
      "admit",
      "retire",
    ] as const)("recovers expired orphan admissions through %s", async (operation) => {
      const { createDrizzleThreadRunOwnership } = await import(
        "../adapters/drizzle-thread-run-ownership.js"
      );
      const { canonicalAdmissionFingerprint } = await import("./user-turn-admission.js");
      const input = {
        actorUserId: USER as never,
        threadId: THREAD,
        submissionId: "orphan",
        text: "saved",
        blocks: [{ type: "text" as const, text: "saved" }],
        references: [],
      };
      await records.reserve({
        ...input,
        fingerprint: canonicalAdmissionFingerprint(input),
        claimExpiresAt: new Date(0),
      });
      const service = createUserTurnAdmission({
        records,
        runOwnership: createDrizzleThreadRunOwnership(firstDb),
        availability: {
          async lookup() {
            throw new Error("Recovery entered reference effects");
          },
        },
        async threadProject() {
          throw new Error("Recovery entered project resolution");
        },
        starter: {
          async start() {
            throw new Error("Recovery started a duplicate turn");
          },
        },
      });
      const remoteOwnership = createDrizzleThreadRunOwnership(secondDb);
      const liveClaim = await remoteOwnership.tryAcquire(THREAD);
      expect(liveClaim).not.toBeNull();
      try {
        await expect(service[operation](input)).resolves.toMatchObject({ kind: "pending" });
      } finally {
        await liveClaim?.release();
      }
      await expect(service[operation](input)).resolves.toMatchObject({
        kind: "rejected",
        code: "recovery_no_committed_turn",
      });
      await expect(
        service.admit({ ...input, text: "changed", blocks: [{ type: "text", text: "changed" }] }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await firstDb.select().from(schema.turns)).toHaveLength(0);
      expect(await firstDb.select().from(schema.eventJournal)).toHaveLength(0);
      const releasedClaim = await remoteOwnership.tryAcquire(THREAD);
      expect(releasedClaim).not.toBeNull();
      await releasedClaim?.release();
    });

    it("does not turn claim expiry into rejection until recovery proves no live claim or committed turn", async () => {
      await firstDb.insert(schema.userTurnAdmissions).values({
        threadId: THREAD,
        submissionId: "pending",
        actorUserId: USER,
        fingerprint: "fingerprint",
        state: "pending",
        claimExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await expect(records.lookup(THREAD, "pending")).resolves.toMatchObject({ state: "pending" });
      await expect(
        records.recoverExpiredPending({
          threadId: THREAD,
          submissionId: "pending",
          now: new Date("2026-01-02T00:00:00.000Z"),
          async hasLiveClaim() {
            return true;
          },
        }),
      ).resolves.toMatchObject({ state: "pending" });
      await expect(
        records.recoverExpiredPending({
          threadId: THREAD,
          submissionId: "pending",
          now: new Date("2026-01-02T00:00:00.000Z"),
          async hasLiveClaim() {
            return false;
          },
        }),
      ).resolves.toMatchObject({ state: "rejected", code: "recovery_no_committed_turn" });
    });
  });
}
