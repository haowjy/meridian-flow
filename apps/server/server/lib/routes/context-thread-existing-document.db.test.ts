/**
 * A thread port's manifest membership. Create, copy, and writer writes onto an
 * existing document check it inside the namespace-locked command transaction;
 * that check must never wait on a lock its own transaction holds. A thread
 * whose writes go live checks the live manifest and drafts nothing (D20, D40).
 * A person's port, with no thread, always uses the live manifest, and a
 * binary copy is always live (D24).
 */

import { randomUUID } from "node:crypto";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { contextPortForProjectBrowse, contextPortForThread, resolveThreadContext } =
      await import("../../domains/context/context-port-resolution.js");
    const { DOCUMENT_RUNTIME_RESET_TABLES, deleteDrizzleRows } = await import(
      "../../test-support/drizzle-reset.js"
    );
    const { useComposedRuntimes } = await import("../../test-support/composed-runtime.js");
    const { writeThreadContextDocument } = await import("../thread-context-route.js");

    const USER_ID = "00000000-0000-4000-8000-000000000b01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000b02";
    const NO_WORK_ID = "00000000-0000-4000-8000-000000000b03";
    const THREAD_ID = "00000000-0000-4000-8000-000000000b04";
    const TURN_ID = "00000000-0000-4000-8000-000000000b05";
    const DIRECT_WORK_ID = "00000000-0000-4000-8000-000000000b06";
    const DRAFT_WORK_ID = "00000000-0000-4000-8000-000000000b07";

    const db = createDb(DATABASE_URL, { max: 6 });
    const runtimes = useComposedRuntimes(() => db);

    /** The production app; the thread resolves from its rows, as a request would. */
    async function createFixture() {
      const runtime = await runtimes.compose();
      const { app, ports } = runtime;
      const routeDeps = {
        contextPorts: app.contextPorts,
        threads: app.threadRepos.threads,
        threadWorks: app.threadRepos.threadWorks,
        works: app.workRepo,
        workAuthorityResolver: app.workAuthorityResolver,
      };
      // The model's `write` tool through the executor, outside a reply.
      const callWrite = (input: Record<string, unknown>) =>
        app.toolExecutor.executeTool(
          { id: randomUUID(), name: "write", arguments: input },
          { threadId: THREAD_ID, turnId: TURN_ID, agentSlug: null },
        );
      return {
        collab: ports.documentSync,
        contextPorts: app.contextPorts,
        objectStore: ports.objectStore,
        routeDeps,
        callWrite,
      };
    }

    type Fixture = Awaited<ReturnType<typeof createFixture>>;
    const succeeded = { result: { status: "success" } };
    /** The model's create or copy onto an existing path without `overwrite`. */
    function expectAlreadyExists(result: { isError?: boolean; output: unknown; result?: unknown }) {
      expect(result).toMatchObject({ isError: true, result: { status: "invalid_write" } });
      expect(result.output).toContain("File already exists");
    }

    async function threadPort(fixture: Fixture) {
      const resolution = await resolveThreadContext(fixture.routeDeps, THREAD_ID);
      if (!resolution) throw new Error("thread did not resolve");
      return contextPortForThread(fixture.contextPorts, resolution, { responseId: null });
    }

    beforeEach(async () => {
      await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
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

    afterAll(async () => {
      await db.close();
    });

    async function seedExisting(fixture: Fixture, path: string) {
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
        const fixture = await createFixture();
        await seedExisting(fixture, "existing.md");

        const refused = await settlesWithin(
          "create",
          fixture.callWrite({
            command: "create",
            path: "manuscript://existing.md",
            content: "New text.",
          }),
        );
        expectAlreadyExists(refused);
        const port = await threadPort(fixture);
        await expect(port.read("manuscript://existing.md")).resolves.toMatchObject({
          ok: true,
          value: { content: "Existing existing.md.\n" },
        });
      });

      it(`overwrites an existing document with the model's create and copy (${label})`, async () => {
        await bindThread(workId);
        const fixture = await createFixture();
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
        expect(created).toMatchObject(succeeded);
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
        expectAlreadyExists(refusedCopy);

        const copied = await settlesWithin(
          "copy overwrite",
          fixture.callWrite({
            command: "copy",
            path: "manuscript://target.md",
            from: { path: "manuscript://source.md" },
            overwrite: true,
          }),
        );
        expect(copied).toMatchObject(succeeded);
        await expect(port.read("manuscript://target.md")).resolves.toMatchObject({
          ok: true,
          value: { content: "Existing source.md.\n" },
        });
      });

      it(`overwrites an existing document through the writer route at once (${label})`, async () => {
        await bindThread(workId);
        const fixture = await createFixture();
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
        const fixture = await createFixture();
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
        ).toMatchObject(succeeded);
        expect(
          await settlesWithin(
            "create",
            fixture.callWrite({
              command: "create",
              path: "manuscript://fresh.md",
              content: "Fresh.",
            }),
          ),
        ).toMatchObject(succeeded);
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
      const fixture = await createFixture();
      expect(
        await settlesWithin(
          "create",
          fixture.callWrite({
            command: "create",
            path: "manuscript://drafted.md",
            content: "Drafted.",
          }),
        ),
      ).toMatchObject(succeeded);

      const port = await threadPort(fixture);
      const drafted = await port.stat("manuscript://drafted.md");
      if (!drafted.ok || !drafted.value.documentId) throw new Error("drafted.md missing");
      const live = await fixture.collab.resolveManifestMembership({
        projectId: PROJECT_ID as never,
      });
      expect(live.members).not.toContain(drafted.value.documentId);
      expect(await manifestThreadBranches()).toHaveLength(1);
    });

    async function manifestWorkDraftBranches(workId: string) {
      return db
        .select({ id: schema.documentBranches.id })
        .from(schema.documentBranches)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.documentBranches.documentId))
        .where(
          and(
            eq(schema.documents.kind, "manifest"),
            eq(schema.documentBranches.workId, workId as never),
          ),
        );
    }

    // People always write live (D20), whatever the Work's AI write mode.
    for (const [label, workId] of [
      ["direct-mode Work", DIRECT_WORK_ID],
      ["draft-mode Work", DRAFT_WORK_ID],
    ] as const) {
      it(`lists and moves through live membership on a writer's ${label} port`, async () => {
        const fixture = await createFixture();
        await seedExisting(fixture, "listed.md");
        const port = await contextPortForProjectBrowse({
          deps: fixture.routeDeps,
          projectId: PROJECT_ID,
          userId: USER_ID,
          workId,
        });
        if (!port) throw new Error("Work port did not resolve");

        await expect(port.list("manuscript://")).resolves.toMatchObject({ ok: true });
        expect(await manifestWorkDraftBranches(workId)).toEqual([]);

        const note = await port.write("scratch://note.md", "A note.\n");
        if (!note.ok) throw new Error(JSON.stringify(note.error));
        const moved = await settlesWithin(
          "move",
          port.move("scratch://note.md", "manuscript://note.md"),
        );
        if (!moved.ok) throw new Error(JSON.stringify(moved.error));

        expect(await manifestWorkDraftBranches(workId)).toEqual([]);
        const live = await fixture.collab.resolveManifestMembership({
          projectId: PROJECT_ID as never,
        });
        const stat = await port.stat("manuscript://note.md");
        if (!stat.ok || !stat.value.documentId) throw new Error("note.md missing");
        expect(live.members).toContain(stat.value.documentId);
      });
    }

    it("records a draft-mode thread's binary copy in the live manifest", async () => {
      await bindThread(DRAFT_WORK_ID);
      const fixture = await createFixture();
      const bytes = new Uint8Array([37, 80, 68, 70]);
      const put = await fixture.objectStore.put(
        `uploads/${PROJECT_ID}/scan`,
        bytes,
        "application/pdf",
      );
      if (!put.ok) throw new Error(put.error.message);
      const source = await fixture.contextPorts
        .forProject(PROJECT_ID, USER_ID, new Map())
        .writeBinary("scratch://scan.pdf", {
          fileType: "pdf",
          storageUrl: put.value.storageUrl,
          mimeType: "application/pdf",
          sizeBytes: bytes.byteLength,
        });
      if (!source.ok) throw new Error(JSON.stringify(source.error));

      const copied = await settlesWithin(
        "binary copy",
        fixture.callWrite({
          command: "copy",
          from: { path: "scratch://@/scan.pdf" },
          path: "kb://refs/scan.pdf",
        }),
      );
      expect(copied).toMatchObject({
        result: { status: "success", path: "kb://refs/scan.pdf", destination: "live" },
      });

      const port = await threadPort(fixture);
      const stat = await port.stat("kb://refs/scan.pdf");
      if (!stat.ok || !stat.value.documentId) throw new Error("kb://refs/scan.pdf missing");
      const live = await fixture.collab.resolveManifestMembership({
        projectId: PROJECT_ID as never,
      });
      expect(live.members).toContain(stat.value.documentId);
    });
  });
}
