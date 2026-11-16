/**
 * PostgreSQL conformance for durable upload identity, allocation, and cascade.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - MIME and extension precedence for canonical upload names and Markdown conversion
 */

import { Hocuspocus } from "@hocuspocus/server";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  projects,
  threads,
  treeNodes,
  uploadIntakes,
  users,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { NO_PROJECT_HINTS } from "../../../test-support/project-hints.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createDrizzleJournal } from "../../collab/adapters/drizzle-journal.js";
import { createCollabDomain } from "../../collab/composition.js";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import {
  createTestDocumentLinkScopes,
  testLinkDeps,
} from "../../collab/test-support/document-link-scopes.js";
import { createAllowAllFileAccess } from "../../file-policy/index.js";
import { createNoopEventSink } from "../../observability/index.js";
import {
  createInMemoryObjectStore,
  createObjectRelease,
  incomingObjectKey,
  type ObjectStorePort,
} from "../../storage/index.js";
import { createDrizzleTreeListStore } from "../adapters/drizzle-tree-list-store.js";
import { createProductionUnifiedContextPortFactory } from "../unified-context-port-factory.js";
import { createContextUploadContentPort } from "./context-upload-content.js";
import { createDrizzleUploadIntakeRepository } from "./drizzle-upload-intake.js";
import { createUploadIntake, type UploadContentPort, type UploadIntake } from "./upload-intake.js";
import { uploadBytes } from "./upload-test-support.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN =
  (process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true") && DATABASE_URL;

if (!RUN) {
  describe.skip("upload intake (postgres)", () => {});
} else {
  describe("upload intake (postgres)", () => {
    const USER = "00000000-0000-4000-8000-000000000a01";
    const PROJECT = "00000000-0000-4000-8000-000000000a02";
    /** A New-chat upload: the chat id is minted by the client and its row does not exist yet. */
    const NEW_CHAT = "00000000-0000-4000-8000-000000000a03";
    /** A chat whose row, and so whose handle `c1`, exists. */
    const CHAT = "00000000-0000-4000-8000-000000000a04";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    async function seed(db: Database = database.current) {
      await db.insert(users).values(conformanceUserValues(USER, "upload-intake"));
      await db
        .insert(projects)
        .values({ id: PROJECT, userId: USER, name: "Project", slug: "project" });
      await db.insert(threads).values({
        id: CHAT,
        projectId: PROJECT,
        rootThreadId: CHAT,
        createdByUserId: USER,
        ref: "c1",
      });
      return createDrizzleUploadIntakeRepository(db, NO_PROJECT_HINTS);
    }

    const reservation = (intakeId: string, chatId: string, filename = "chapter.md") => ({
      intakeId,
      actorUserId: USER,
      owner: { kind: "chat" as const, projectId: PROJECT, chatId },
      filename,
      mimeType: "text/markdown",
      sizeBytes: 10,
    });

    const claimInput = (intakeId: string) => ({
      projectId: PROJECT,
      intakeId,
      fileType: "markdown" as const,
    });

    /** The intake as production composes it, over `db`. */
    function productionIntake(
      db: Database,
      objectStore: ObjectStorePort,
      collab = createInMemoryCollabDomain(),
    ) {
      const contextPorts = createProductionUnifiedContextPortFactory({
        sourceHints: NO_PROJECT_HINTS,
        treeLists: createDrizzleTreeListStore({ db: db, journal: createDrizzleJournal(db) }),
        pendingBranch: createTestWorkProjectionMutation(db),
        links: createTestDocumentLinkScopes(db),
        db,
        documentSync: collab,
        branches: collab.branches,
      });
      return createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(db, NO_PROJECT_HINTS),
        content: createContextUploadContentPort(contextPorts),
        objectStore,
        release: createObjectRelease({ objectStore, onFailure() {} }),
        eventSink: createNoopEventSink(),
      });
    }

    it("converges concurrent production service calls on the authoritative trio", async () => {
      const firstDb = createDb(DATABASE_URL);
      const waiterDb = createDb(DATABASE_URL);
      try {
        await seed(firstDb);
        const collab = createInMemoryCollabDomain();
        const objectStore = createInMemoryObjectStore();
        const service = (db: Database) => productionIntake(db, objectStore, collab);
        const content = new TextEncoder().encode("# Concurrent\n");
        const request = () => ({
          intakeId: "concurrent-service",
          actorUserId: USER,
          projectId: PROJECT,
          chatId: NEW_CHAT,
          filename: "chapter.md",
          mimeType: "text/markdown",
          bytes: content,
        });

        // Settle both calls before `finally` deletes the user: a rejected
        // Promise.all would leave the other transaction running into the delete.
        const settled = await Promise.allSettled([
          uploadBytes(service(firstDb), objectStore, request()),
          uploadBytes(service(waiterDb), objectStore, request()),
        ]);
        const [first, waiter] = settled.map((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason;
          return outcome.value;
        });

        expect(first).toEqual(waiter);
        expect(first).toMatchObject({
          ok: true,
          value: { uri: "uploads://chapter", fileType: "markdown" },
        });

        // Two uploads of one name at once: both keep it, and the later to land is the twin.
        const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]);
        const twin = (db: Database) =>
          uploadBytes(service(db), objectStore, {
            actorUserId: USER,
            projectId: PROJECT,
            chatId: NEW_CHAT,
            filename: "notes.zip",
            mimeType: "application/zip",
            bytes: zip,
          });
        const twins = await Promise.allSettled([twin(firstDb), twin(waiterDb)]);
        expect(
          twins
            .map((outcome) =>
              outcome.status === "fulfilled" && outcome.value.ok
                ? outcome.value.value.uri
                : outcome,
            )
            .sort(),
        ).toEqual([
          "uploads://notes.zip",
          expect.stringMatching(/^uploads:\/\/notes\.zip~[0-9a-f]{4,}$/),
        ]);
      } finally {
        await firstDb.delete(users).where(eq(users.id, USER));
        await Promise.all([firstDb.close(), waiterDb.close()]);
      }
    });

    it("converges idempotency, names the file where it lands, derives the address from the chat's handle, and keeps a taken name as a twin", async () => {
      const repo = await seed();
      const first = await repo.reserve(reservation("one", NEW_CHAT));
      const replay = await repo.reserve(reservation("one", NEW_CHAT));
      const conflict = await repo.reserve(reservation("one", NEW_CHAT, "other.md"));
      if (first.kind !== "reserved") throw new Error(first.kind);
      // Neither a reservation nor a claim holds a name: the upload is named where it lands.
      expect(first.reservation).toMatchObject({
        finalPath: null,
        fileType: null,
        state: "reserved",
      });
      expect(replay.kind === "existing" && replay.reservation.documentId).toBe(
        first.reservation.documentId,
      );
      expect(conflict).toEqual({ kind: "conflict" });
      const claimed = await repo.claim(claimInput("one"));
      expect(claimed.kind === "claimed" && claimed.reservation.finalPath).toBe(null);

      // Through the chat's own port.
      const objectStore = createInMemoryObjectStore();
      const intake = productionIntake(database.current, objectStore);
      const send = (chatId: string, filename: string, mimeType: string, bytes: Uint8Array) =>
        uploadBytes(intake, objectStore, {
          actorUserId: USER,
          projectId: PROJECT,
          chatId,
          filename,
          mimeType,
          bytes,
        });
      const text = new TextEncoder().encode("# Hello\n");
      const zip = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]);
      const uris = async (sends: Promise<Awaited<ReturnType<typeof send>>>[]) =>
        (await Promise.all(sends)).map((sent) => (sent.ok ? sent.value.uri : sent.error.code));
      expect(await uris([send(NEW_CHAT, "chapter.md", "text/markdown", text)])).toEqual([
        "uploads://chapter",
      ]);
      expect(await uris([send(NEW_CHAT, "chapter.md", "text/markdown", text)])).toEqual([
        expect.stringMatching(/^uploads:\/\/chapter~[0-9a-f]{4,}$/),
      ]);
      expect(await uris([send(CHAT, "notes.zip", "application/zip", zip)])).toEqual([
        "uploads://@c1/notes.zip",
      ]);
      expect(await uris([send(CHAT, "notes.zip", "application/zip", zip)])).toEqual([
        expect.stringMatching(/^uploads:\/\/@c1\/notes\.zip~[0-9a-f]{4,}$/),
      ]);

      // The New chat gets its row, and so its handle, at Send: the same upload now reads there.
      const finalized = await repo.finalize(PROJECT, "one", "draft");
      expect(finalized.canonicalUri).toBe("uploads://draft");
      await database.current.insert(threads).values({
        id: NEW_CHAT,
        projectId: PROJECT,
        rootThreadId: NEW_CHAT,
        createdByUserId: USER,
        ref: "c2",
      });
      const afterSend = await repo.reserve(reservation("one", NEW_CHAT));
      expect(afterSend.kind === "existing" && afterSend.reservation.canonicalUri).toBe(
        "uploads://@c2/draft",
      );
    });

    it("stores writer names, preserves original filenames and parses all prose as markdown", async () => {
      const db = createDb(DATABASE_URL);
      try {
        await seed(db);
        await db.insert(contextSources).values({
          projectId: PROJECT,
          scope: "project",
          slug: "manuscript",
        });
        const collab = createCollabDomain({
          ...testLinkDeps(db),
          db: db,
          ...createTestRemovalDeps(db),
          fileAccess: createAllowAllFileAccess(),
          workProjectionMutation: createTestWorkProjectionMutation(db),
        });
        collab.bindHocuspocus(
          new Hocuspocus({
            yDocOptions: { gc: false, gcFilter: () => true },
            onStoreDocument: ({ documentName, document }) =>
              collab.storeHocuspocusDocument(documentName, document),
          }),
        );
        const contextPorts = createProductionUnifiedContextPortFactory({
          sourceHints: NO_PROJECT_HINTS,
          treeLists: createDrizzleTreeListStore({ db: db, journal: createDrizzleJournal(db) }),
          pendingBranch: createTestWorkProjectionMutation(db),
          links: createTestDocumentLinkScopes(db),
          db: db,
          documentSync: collab,
          branches: collab.branches,
        });
        const intakeStore = createInMemoryObjectStore();
        const service = createUploadIntake({
          repository: createDrizzleUploadIntakeRepository(db, NO_PROJECT_HINTS),
          content: createContextUploadContentPort(contextPorts),
          objectStore: intakeStore,
          release: createObjectRelease({ objectStore: intakeStore, onFailure() {} }),
          eventSink: createNoopEventSink(),
        });
        const text =
          "# Chapter One\n\nThe temperature was <10 degrees. {The crowd roared} *loudly*.";
        const content = new TextEncoder().encode(text);
        const cases = [
          ["Chapter 13.md", "text/markdown", "Chapter 13", "", "markdown"],
          // The same name again: each keeps it, a twin whose path carries `~id`.
          ["Chapter 13.markdown", "application/octet-stream", "Chapter 13", "", "markdown"],
          ["Chapter 13.mdx", "application/octet-stream", "Chapter 13", "", "markdown"],
          ["Chapter 13.txt", "text/plain", "Chapter 13", "", "markdown"],
          ["Chapter 14", "text/markdown", "Chapter 14", "", "markdown"],
          ["Chapter 15", "text/plain", "Chapter 15", "", "markdown"],
          ["config", "application/json", "config", "json", "json"],
          ["Vol. 2", "application/json", "Vol. 2", "json", "json"],
          ["Pic.PNG", "image/png", "Pic", "png", "image"],
          ["Cover", "image/png", "Cover", "png", "image"],
          ["Binary.txt", "application/pdf", "Binary", "pdf", "pdf"],
          ["LICENSE", "application/pdf", "LICENSE", "pdf", "pdf"],
        ];
        const landed = new Set<string>();
        for (const [filename, mimeType, name, extension, fileType] of cases) {
          const result = await uploadBytes(service, intakeStore, {
            intakeId: filename,
            actorUserId: USER,
            projectId: PROJECT,
            chatId: NEW_CHAT,
            filename,
            mimeType,
            bytes: content,
          });
          if (!result.ok) throw new Error(result.error.code);
          const leaf = `${name}${extension ? `.${extension}` : ""}`;
          expect(result.value.fileType).toBe(fileType);
          expect(
            result.value.uri === `uploads://${leaf}` ? !landed.has(leaf) : landed.has(leaf),
          ).toBe(true);
          if (result.value.uri !== `uploads://${leaf}`)
            expect(result.value.uri).toMatch(/^uploads:\/\/Chapter 13~[0-9a-f]{4,}$/);
          landed.add(leaf);
          const [document] = await db
            .select()
            .from(treeNodes)
            .where(eq(treeNodes.id, result.value.documentId as never));
          // The tree row stores the name with its extension.
          expect(document).toMatchObject({
            name: extension ? `${name}.${extension}` : name,
            extension,
          });
          const [intake] = await db
            .select()
            .from(uploadIntakes)
            .where(eq(uploadIntakes.documentId, result.value.documentId as never));
          expect(intake?.filename).toBe(filename);
          if (fileType === "markdown") {
            expect(await collab.readAsMarkdown(result.value.documentId as never)).toEqual({
              ok: true,
              value: `${text.replace("<10", "\\<10").replace("{The", "\\{The")}\n`,
            });
          }
        }
      } finally {
        await db.delete(users).where(eq(users.id, USER));
        await db.close();
      }
    });

    it("finalizes tracked Yjs content and catalog identity in the authoritative boundary", async () => {
      await seed();
      const collab = createInMemoryCollabDomain();
      const contextPorts = createProductionUnifiedContextPortFactory({
        sourceHints: NO_PROJECT_HINTS,
        treeLists: createDrizzleTreeListStore({
          db: database.current,
          journal: createDrizzleJournal(database.current),
        }),
        pendingBranch: createTestWorkProjectionMutation(database.current),
        links: createTestDocumentLinkScopes(database.current),
        db: database.current,
        documentSync: collab,
        branches: collab.branches,
      });
      const unusedStore = createInMemoryObjectStore();
      const service = createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(database.current, NO_PROJECT_HINTS),
        content: createContextUploadContentPort(contextPorts),
        objectStore: unusedStore,
        release: createObjectRelease({ objectStore: unusedStore, onFailure() {} }),
        eventSink: createNoopEventSink(),
      });
      const content = new TextEncoder().encode("# Chapter One\n\nIt began.");
      const result = await uploadBytes(service, unusedStore, {
        intakeId: "tracked",
        actorUserId: USER,
        projectId: PROJECT,
        chatId: NEW_CHAT,
        filename: "chapter.md",
        mimeType: "text/markdown",
        bytes: content,
      });
      if (!result.ok) throw new Error(result.error.code);
      expect(await collab.readAsMarkdown(result.value.documentId as never)).toEqual({
        ok: true,
        value: "# Chapter One\n\nIt began.\n",
      });
      const [stored] = await database.current
        .select({ chatThreadId: contextSources.chatThreadId })
        .from(treeNodes)
        .innerJoin(contextSources, eq(contextSources.id, treeNodes.contextSourceId))
        .where(eq(treeNodes.id, result.value.documentId as never));
      expect(stored?.chatThreadId).toBe(NEW_CHAT);
    });

    describe("start, PUT, finish", () => {
      type Content = UploadContentPort<null>;

      async function flow(overrides: { content?: Partial<Content> } = {}) {
        const repo = await seed();
        const store = createInMemoryObjectStore();
        const bound: string[] = [];
        const content: Content = {
          bind: async ({ text }) => {
            bound.push(text);
            return { ok: true, bound: null };
          },
          persist: async ({ reservation }) => ({ ok: true, finalPath: reservation.finalPath }),
          ...overrides.content,
        };
        const intake: UploadIntake = createUploadIntake({
          repository: repo,
          content,
          objectStore: store,
          release: createObjectRelease({ objectStore: store, onFailure() {} }),
          eventSink: createNoopEventSink(),
        });
        const owner = { kind: "chat" as const, projectId: PROJECT, chatId: NEW_CHAT };
        const bytesOf = (size: number, text = "") =>
          new Uint8Array(size).map((_, i) => text.charCodeAt(i) || 0x78);
        return {
          intake,
          store,
          bound,
          start: (
            intakeId: string,
            size: number,
            filename = "map.pdf",
            mimeType = "application/pdf",
          ) =>
            intake.start({
              intakeId,
              actorUserId: USER,
              owner,
              filename,
              mimeType,
              sizeBytes: size,
            }),
          finish: (intakeId: string) => intake.finish({ intakeId, actorUserId: USER, owner }),
          put: (documentId: string, bytes: Uint8Array, mimeType = "application/pdf") =>
            store.put(incomingObjectKey(PROJECT, documentId), bytes, mimeType),
          keys: async () => {
            const listed = await store.list("");
            return listed.ok ? listed.value.keys.map((entry) => entry.key) : [];
          },
          bytesOf,
        };
      }
      const reservedOf = (
        started: Awaited<ReturnType<Awaited<ReturnType<typeof flow>>["start"]>>,
      ) => {
        if (!started.ok || started.value.state === "finalized") throw new Error("not reserved");
        return started.value;
      };

      it("answers each retry by the state the upload has reached", async () => {
        const f = await flow();
        const bytes = f.bytesOf(8);
        const first = reservedOf(await f.start("retry", 8));
        expect(first.state).toBe("reserved");
        expect(reservedOf(await f.start("retry", 8)).documentId).toBe(first.documentId);
        // Finish before the PUT keeps the row, so the writer can PUT and finish again.
        expect(await f.finish("retry")).toEqual({ ok: false, error: { code: "not_uploaded" } });
        await f.put(first.documentId, bytes);
        const done = await f.finish("retry");
        expect(done).toMatchObject({ ok: true, value: { documentId: first.documentId } });
        expect(await f.finish("retry")).toEqual(done);
        expect(await f.start("retry", 8)).toMatchObject({
          ok: true,
          value: { state: "finalized" },
        });
        expect(await f.keys()).toEqual([`uploads/${PROJECT}/${first.documentId}`]);
        // A different name or size for the same intake is a different upload.
        expect(await f.start("retry", 9)).toEqual({
          ok: false,
          error: { code: "idempotency_conflict" },
        });
      });

      it("refuses an object of another length, drops it, and lets the writer upload again", async () => {
        const f = await flow();
        const first = reservedOf(await f.start("short", 8));
        await f.put(first.documentId, f.bytesOf(4));
        expect(await f.finish("short")).toEqual({ ok: false, error: { code: "size_mismatch" } });
        expect(await f.keys()).toEqual([]);
        const again = reservedOf(await f.start("short", 8));
        expect(again.state).toBe("reserved");
        await f.put(first.documentId, f.bytesOf(8));
        expect((await f.finish("short")).ok).toBe(true);
      });

      it("reads type and text from the stored bytes, never from the declared name", async () => {
        const f = await flow();
        // Declared as Markdown; the stored bytes are a PDF of the same length.
        const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");
        const first = reservedOf(
          await f.start("liar", pdf.byteLength, "notes.md", "text/markdown"),
        );
        await f.put(first.documentId, pdf, "text/markdown");
        const result = await f.finish("liar");
        expect(result.ok && result.value.fileType).toBe("pdf");
        expect(f.bound).toEqual([""]);
        // Text is bound as read from the object.
        const text = "# Real text\n";
        const second = reservedOf(await f.start("honest", text.length, "real.md", "text/markdown"));
        await f.put(second.documentId, new TextEncoder().encode(text), "text/markdown");
        expect((await f.finish("honest")).ok).toBe(true);
        expect(f.bound.at(-1)).toBe(text);
      });

      it("resumes from the stored object when persisting fails, without deleting anything", async () => {
        let fail = true;
        const f = await flow({
          content: {
            persist: async ({ reservation }) =>
              fail ? { ok: false } : { ok: true, finalPath: reservation.finalPath },
          },
        });
        const first = reservedOf(await f.start("resume", 8));
        await f.put(first.documentId, f.bytesOf(8));
        expect(await f.finish("resume")).toEqual({ ok: false, error: { code: "storage_failed" } });
        // The bytes are already checked and stored: starting again skips the PUT.
        expect(await f.start("resume", 8)).toMatchObject({ ok: true, value: { state: "stored" } });
        expect(await f.keys()).toContain(`uploads/${PROJECT}/${first.documentId}`);
        fail = false;
        expect((await f.finish("resume")).ok).toBe(true);
        expect(await f.keys()).toEqual([`uploads/${PROJECT}/${first.documentId}`]);
      });

      it("sweeps uploads untouched for a day, objects and row, and leaves the rest", async () => {
        const f = await flow();
        const quiet = reservedOf(await f.start("quiet", 8));
        await f.put(quiet.documentId, f.bytesOf(8));
        const finished = reservedOf(await f.start("finished", 8));
        await f.put(finished.documentId, f.bytesOf(8));
        expect((await f.finish("finished")).ok).toBe(true);
        expect(await f.intake.sweepAbandoned()).toBe(0);
        const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
        expect(await f.intake.sweepAbandoned(later)).toBe(1);
        expect(await f.keys()).toEqual([`uploads/${PROJECT}/${finished.documentId}`]);
        expect(await f.start("quiet", 8)).toMatchObject({ ok: true, value: { state: "reserved" } });
      });
    });
  });
}
