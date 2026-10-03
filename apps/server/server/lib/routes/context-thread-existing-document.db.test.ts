/**
 * A thread port's manifest membership. Create, copy, and writer writes onto an
 * existing document check it inside the namespace-locked command transaction;
 * that check must never wait on a lock its own transaction holds. A thread
 * whose writes go live checks the live manifest and drafts nothing (D20, D40).
 */

import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

/** A deadlock shows up as a hang; fail fast and name the call instead. */
function settlesWithin<T>(label: string, promise: Promise<T>, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms);
    }),
  ]);
}

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("thread writes onto existing documents (postgres)", () => {});
} else {
  describe("thread writes onto existing documents (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../../domains/collab/composition.js");
    const { createProductionUnifiedContextPortFactory } = await import(
      "../../domains/context/unified-context-port-factory.js"
    );
    const { contextPortForThread, resolveThreadContext } = await import(
      "../../domains/context/context-port-resolution.js"
    );
    const { createDrizzleProjectWorkAuthorityResolver, createDrizzleProjectWorkRepository } =
      await import("../../domains/projects/index.js");
    const { createDrizzleDocumentAccess } = await import("../document-access.js");
    const { deleteDrizzleRows } = await import("../../test-support/drizzle-reset.js");
    const { writeThreadContextDocument } = await import("../thread-context-route.js");
    const { createAgentEditResponseWriteLifecycle, createWiredCoreToolRegistrations } =
      await import("../wired-core-tools.js");
    const { createInMemoryObjectStore } = await import("../../domains/storage/index.js");
    const { createNoopEventSink } = await import("../../domains/observability/index.js");

    const USER_ID = "00000000-0000-4000-8000-000000000b01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000b02";
    const NO_WORK_ID = "00000000-0000-4000-8000-000000000b03";
    const THREAD_ID = "00000000-0000-4000-8000-000000000b04";
    const TURN_ID = "00000000-0000-4000-8000-000000000b05";
    const DIRECT_WORK_ID = "00000000-0000-4000-8000-000000000b06";
    const DRAFT_WORK_ID = "00000000-0000-4000-8000-000000000b07";

    const db = createDb(DATABASE_URL, { max: 6 });
    const fixtures: Array<{
      collab: ReturnType<typeof createCollabDomain>;
      hocuspocus: InstanceType<typeof Hocuspocus>;
    }> = [];

    function createFixture(primaryWorkId = NO_WORK_ID) {
      const collab = createCollabDomain({
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        documentAccess: createDrizzleDocumentAccess(db),
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        async onLoadDocument({ documentName, document }) {
          const state = await collab.loadHocuspocusDocument(documentName);
          if (state) Y.applyUpdate(document, state);
        },
        onStoreDocument: ({ documentName, document }) =>
          collab.storeHocuspocusDocument(documentName, document),
      });
      collab.bindHocuspocus(hocuspocus);
      fixtures.push({ collab, hocuspocus });
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: collab,
        manifestMembership: collab,
      });
      const routeDeps = {
        contextPorts,
        threads: {
          findById: async (id: string) =>
            id === THREAD_ID
              ? ({ id: THREAD_ID, projectId: PROJECT_ID, userId: USER_ID } as never)
              : null,
        },
        threadWorks: {
          findPrimary: async (threadId: string) =>
            threadId === THREAD_ID ? ({ threadId, workId: primaryWorkId } as never) : null,
        },
        works: createDrizzleProjectWorkRepository({
          db,
          projectionMutation: createTestWorkProjectionMutation(db),
        }),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
      };
      const registrations = createWiredCoreToolRegistrations({
        ...routeDeps,
        threads: routeDeps.threads as never,
        threadWorks: routeDeps.threadWorks as never,
        documentSync: collab,
        responseWrites: createAgentEditResponseWriteLifecycle({ documentSync: collab }),
        drafts: collab,
        workContextNotices: { workChanged: async () => {}, threadChanged: async () => {} },
        stopThreadRun: async () => {},
        eventSink: createNoopEventSink(),
        transaction: (operation) => operation(),
        objectStore: createInMemoryObjectStore(),
      });
      const write = registrations.find((registration) => registration.definition.name === "write");
      if (write?.execution.type !== "server") throw new Error("write tool is not registered");
      const handler = write.execution.handler as (
        input: unknown,
        context: unknown,
      ) => Promise<unknown>;
      // The model's `write` tool, called as the executor would call it.
      const callWrite = (input: Record<string, unknown>) =>
        handler(write.input.parse(input), {
          signal: new AbortController().signal,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          agentSlug: null,
        }).then((result) => JSON.stringify(result));
      return { collab, contextPorts, routeDeps, callWrite };
    }

    async function threadPort(fixture: ReturnType<typeof createFixture>) {
      const resolution = await resolveThreadContext(fixture.routeDeps, THREAD_ID);
      if (!resolution) throw new Error("thread did not resolve");
      return contextPortForThread(fixture.contextPorts, resolution, { responseId: null });
    }

    beforeEach(async () => {
      await deleteDrizzleRows(db, [
        schema.branchPushOutboxUpdates,
        schema.branchPushSettlementOutbox,
        schema.turnTrailWork,
        schema.changeTrailDeliveryOutbox,
        schema.changeTrailDocumentDetails,
        schema.changeTrailDocumentOccurrences,
        schema.changeTrailShells,
        schema.pendingNotices,
        schema.documentYjsReversalOps,
        schema.documentYjsReversals,
        schema.agentEditWidCounters,
        schema.agentEditMutations,
        schema.branchWriteJournal,
        schema.pushLineage,
        schema.documentBranches,
        schema.documentYjsCheckpoints,
        schema.documentYjsHeads,
        schema.documentYjsUpdates,
        schema.modelResponses,
        schema.threadWorks,
        schema.turns,
        schema.threads,
        schema.folders,
        schema.documents,
        schema.contextSources,
        schema.works,
        schema.projects,
        schema.users,
      ]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "thread-existing"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "thread-existing" });
      await db.insert(schema.contextSources).values({
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(schema.works).values({
        id: NO_WORK_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        name: "No Work",
        isNoWork: true,
      });
      await db.insert(schema.works).values([
        {
          id: DIRECT_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Direct",
          slug: "direct",
          aiWriteMode: "direct",
        },
        {
          id: DRAFT_WORK_ID,
          projectId: PROJECT_ID,
          createdByUserId: USER_ID,
          name: "Draft",
          slug: "draft",
          aiWriteMode: "draft",
        },
      ]);
      await db.insert(schema.threads).values({
        rootThreadId: THREAD_ID,
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread",
        kind: "primary",
        status: "idle",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      // A write called outside a reply records its turn as the authoring response.
      await db.insert(schema.modelResponses).values({
        id: TURN_ID,
        turnId: TURN_ID,
        sequence: 1,
        provider: "fixture",
        model: "fixture",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      await db.insert(schema.threadWorks).values({
        threadId: THREAD_ID,
        workId: NO_WORK_ID,
        projectId: PROJECT_ID,
        isPrimary: true,
      });
    });

    afterEach(async () => {
      for (const { collab, hocuspocus } of fixtures.splice(0)) {
        hocuspocus.closeConnections();
        hocuspocus.flushPendingStores();
        await collab.drainHocuspocusPersistence();
      }
    });

    afterAll(async () => {
      await db.close();
    });

    async function seedExisting(fixture: ReturnType<typeof createFixture>, path: string) {
      const port = await threadPort(fixture);
      const created = await settlesWithin(
        `seed ${path}`,
        port.write(`manuscript://${path}`, `Existing ${path}.\n`),
      );
      if (!created.ok || !created.value.documentId) throw new Error(`could not seed ${path}`);
      await fixture.collab.drainHocuspocusPersistence();
      return created.value.documentId;
    }

    async function bindThread(workId: string) {
      await db
        .update(schema.threadWorks)
        .set({ workId })
        .where(eq(schema.threadWorks.threadId, THREAD_ID));
    }

    // A draft-mode thread pulls the manifest's thread peer inside the command
    // transaction, the path that deadlocked; a No Work thread checks live membership.
    for (const [label, workId] of [
      ["No Work", NO_WORK_ID],
      ["draft-mode Work", DRAFT_WORK_ID],
    ] as const) {
      it(`refuses the model's plain create onto an existing document at once (${label})`, async () => {
        await bindThread(workId);
        const fixture = createFixture(workId);
        await seedExisting(fixture, "existing.md");

        const refused = await settlesWithin(
          "create",
          fixture.callWrite({
            command: "create",
            path: "manuscript://existing.md",
            content: "New text.",
          }),
        );
        expect(refused).toContain("File already exists");
        const port = await threadPort(fixture);
        await expect(port.read("manuscript://existing.md")).resolves.toMatchObject({
          ok: true,
          value: { content: "Existing existing.md.\n" },
        });
      });

      it(`overwrites an existing document with the model's create and copy (${label})`, async () => {
        await bindThread(workId);
        const fixture = createFixture(workId);
        await seedExisting(fixture, "target.md");
        await seedExisting(fixture, "source.md");
        const port = await threadPort(fixture);

        const created = await settlesWithin(
          "create overwrite",
          fixture.callWrite({
            command: "create",
            path: "manuscript://target.md",
            content: "Created over.",
            overwrite: true,
          }),
        );
        expect(created).not.toContain("error");
        await expect(port.read("manuscript://target.md")).resolves.toMatchObject({
          ok: true,
          value: { content: "Created over.\n" },
        });

        const refusedCopy = await settlesWithin(
          "copy",
          fixture.callWrite({
            command: "copy",
            path: "manuscript://target.md",
            from: { path: "manuscript://source.md" },
          }),
        );
        expect(refusedCopy).toContain("File already exists");

        const copied = await settlesWithin(
          "copy overwrite",
          fixture.callWrite({
            command: "copy",
            path: "manuscript://target.md",
            from: { path: "manuscript://source.md" },
            overwrite: true,
          }),
        );
        expect(copied).not.toContain("error");
        await expect(port.read("manuscript://target.md")).resolves.toMatchObject({
          ok: true,
          value: { content: "Existing source.md.\n" },
        });
      });

      it(`overwrites an existing document through the writer route at once (${label})`, async () => {
        await bindThread(workId);
        const fixture = createFixture(workId);
        const existingId = await seedExisting(fixture, "writer.md");

        await expect(
          settlesWithin(
            "writer route write",
            writeThreadContextDocument(fixture.routeDeps, {
              threadId: THREAD_ID as ThreadId,
              userId: USER_ID as UserId,
              uri: "manuscript://writer.md",
              markdown: "Writer replaced this.\n",
            }),
          ),
        ).resolves.toMatchObject({ documentId: existingId });
        const port = await threadPort(fixture);
        await expect(port.read("manuscript://writer.md")).resolves.toMatchObject({
          ok: true,
          value: { content: "Writer replaced this.\n" },
        });
      });
    }

    async function manifestThreadBranches() {
      return db
        .select({ id: schema.documentBranches.id })
        .from(schema.documentBranches)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.documentBranches.documentId))
        .where(
          and(
            eq(schema.documents.kind, "manifest"),
            eq(schema.documentBranches.threadId, THREAD_ID),
          ),
        );
    }

    for (const [label, workId] of [
      ["No Work", NO_WORK_ID],
      ["direct-mode Work", DIRECT_WORK_ID],
    ] as const) {
      it(`keeps no .manifest thread branch for a ${label} thread`, async () => {
        await bindThread(workId);
        const fixture = createFixture(workId);
        await seedExisting(fixture, "kept.md");

        const port = await threadPort(fixture);
        await expect(port.read("manuscript://kept.md")).resolves.toMatchObject({ ok: true });
        await expect(port.list("manuscript://")).resolves.toMatchObject({ ok: true });
        await expect(port.search("Existing", "manuscript://")).resolves.toMatchObject({
          ok: true,
        });
        expect(
          await settlesWithin(
            "edit",
            fixture.callWrite({
              command: "create",
              path: "manuscript://kept.md",
              content: "Replaced.",
              overwrite: true,
            }),
          ),
        ).not.toContain("error");
        expect(
          await settlesWithin(
            "create",
            fixture.callWrite({
              command: "create",
              path: "manuscript://fresh.md",
              content: "Fresh.",
            }),
          ),
        ).not.toContain("error");
        await expect(port.read("manuscript://fresh.md")).resolves.toMatchObject({
          ok: true,
          value: { content: "Fresh.\n" },
        });

        expect(await manifestThreadBranches()).toEqual([]);
        const live = await fixture.collab.resolveManifestMembership({
          projectId: PROJECT_ID as never,
        });
        const fresh = await port.stat("manuscript://fresh.md");
        if (!fresh.ok || !fresh.value.documentId) throw new Error("fresh.md missing");
        expect(live.members).toContain(fresh.value.documentId);
      });
    }

    it("lists a draft-mode thread's drafted create through its own manifest", async () => {
      await bindThread(DRAFT_WORK_ID);
      const fixture = createFixture(DRAFT_WORK_ID);
      expect(
        await settlesWithin(
          "create",
          fixture.callWrite({
            command: "create",
            path: "manuscript://drafted.md",
            content: "Drafted.",
          }),
        ),
      ).not.toContain("error");

      const port = await threadPort(fixture);
      const drafted = await port.stat("manuscript://drafted.md");
      if (!drafted.ok || !drafted.value.documentId) throw new Error("drafted.md missing");
      const live = await fixture.collab.resolveManifestMembership({
        projectId: PROJECT_ID as never,
      });
      expect(live.members).not.toContain(drafted.value.documentId);
      expect(await manifestThreadBranches()).toHaveLength(1);
    });
  });
}
