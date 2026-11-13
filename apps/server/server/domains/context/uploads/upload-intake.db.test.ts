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
  documents,
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
import { treeSeeder } from "../../../test-support/tree-seed.js";
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
    const NEW_OWNER = { kind: "chat" as const, projectId: PROJECT, chatId: NEW_CHAT };
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
      return createDrizzleUploadIntakeRepository(db);
    }

    /** Deletion through the aggregate; `removed` records arrived uploads it soft-deleted. */
    function deletion(repository: ReturnType<typeof createDrizzleUploadIntakeRepository>) {
      const removed: string[] = [];
      const intakeStore = createInMemoryObjectStore();
      const intake = createUploadIntake({
        repository,
        content: {
          names: async () => new Set(),
          bind: async () => ({ ok: true, bound: null }),
          persist: async () => ({ ok: true }),
          async remove({ reservation }) {
            removed.push(reservation.documentId);
            return { ok: true };
          },
        },
        objectStore: intakeStore,
        release: createObjectRelease({ objectStore: intakeStore, onFailure() {} }),
        eventSink: createNoopEventSink(),
      });
      return { removed, deleteDraft: intake.deleteDraft };
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
        treeLists: createDrizzleTreeListStore({ db: db, journal: createDrizzleJournal(db) }),
        pendingBranch: createTestWorkProjectionMutation(db),
        links: createTestDocumentLinkScopes(db),
        db,
        documentSync: collab,
        branches: collab.branches,
      });
      return createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(db),
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

        // Two uploads of one name at once: both read the folder before either lands, so the
        // second learns the name is taken from the port's conflict and takes the next.
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
        ).toEqual(["uploads://notes (2).zip", "uploads://notes.zip"]);
      } finally {
        await firstDb.delete(users).where(eq(users.id, USER));
        await Promise.all([firstDb.close(), waiterDb.close()]);
      }
    });

    it("converges idempotency, names the file where it lands, derives the address from the chat's handle, and numbers a taken name", async () => {
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

      // Through the chat's own port: the folder is read before the write.
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
        "uploads://chapter (2)",
      ]);
      expect(await uris([send(CHAT, "notes.zip", "application/zip", zip)])).toEqual([
        "uploads://@c1/notes.zip",
      ]);
      expect(await uris([send(CHAT, "notes.zip", "application/zip", zip)])).toEqual([
        "uploads://@c1/notes (2).zip",
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

    it("deletes only the exact unused identity and preserves revision mismatches", async () => {
      const repo = await seed();
      const reserved = await repo.reserve(reservation("delete", NEW_CHAT));
      if (reserved.kind === "conflict" || reserved.kind === "owner_unavailable") {
        throw new Error("reservation failed");
      }
      const claimed = await repo.claim(claimInput("delete"));
      if (claimed.kind !== "claimed") throw new Error(claimed.kind);
      const { documentId } = claimed.reservation;
      const [intake] = await database.current
        .select()
        .from(uploadIntakes)
        .where(eq(uploadIntakes.documentId, documentId as never));
      if (!intake) throw new Error("intake missing");
      await treeSeeder(database.current).document(intake.contextSourceId as string, "chapter", {
        id: documentId,
      });
      const identity = await repo.finalize(PROJECT, "delete", "chapter");
      const base = { intakeId: "delete", documentId, uri: identity.canonicalUri ?? "" };
      const { removed, deleteDraft } = deletion(repo);
      expect(await deleteDraft({ ...base, expectedRevision: "wrong" }, USER, NEW_OWNER)).toEqual({
        kind: "identity_mismatch",
      });
      expect(
        await deleteDraft(
          { ...base, expectedRevision: identity.locationRevision },
          USER,
          NEW_OWNER,
        ),
      ).toEqual({ kind: "deleted" });
      expect(
        await deleteDraft(
          { ...base, expectedRevision: identity.locationRevision },
          USER,
          NEW_OWNER,
        ),
      ).toEqual({ kind: "already_deleted" });
      // An arrived upload leaves through the canonical soft delete, never a hard delete.
      expect(removed).toEqual([documentId]);
      expect(
        await database.current
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, documentId as never)),
      ).toHaveLength(1);
    });

    it("stores writer names, preserves original filenames and parses all prose as markdown", async () => {
      const db = createDb(DATABASE_URL);
      try {
        await seed(db);
        await db.insert(contextSources).values({
          projectId: PROJECT,
          scope: "project",
          slug: "manuscript",
          name: "Manuscript",
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
          treeLists: createDrizzleTreeListStore({ db: db, journal: createDrizzleJournal(db) }),
          pendingBranch: createTestWorkProjectionMutation(db),
          links: createTestDocumentLinkScopes(db),
          db: db,
          documentSync: collab,
          branches: collab.branches,
        });
        const intakeStore = createInMemoryObjectStore();
        const service = createUploadIntake({
          repository: createDrizzleUploadIntakeRepository(db),
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
          ["Chapter 13.markdown", "application/octet-stream", "Chapter 13 (2)", "", "markdown"],
          ["Chapter 13.mdx", "application/octet-stream", "Chapter 13 (3)", "", "markdown"],
          ["Chapter 13.txt", "text/plain", "Chapter 13 (4)", "", "markdown"],
          ["Chapter 14", "text/markdown", "Chapter 14", "", "markdown"],
          ["Chapter 15", "text/plain", "Chapter 15", "", "markdown"],
          ["config", "application/json", "config", "json", "json"],
          ["Vol. 2", "application/json", "Vol. 2", "json", "json"],
          ["Pic.PNG", "image/png", "Pic", "png", "image"],
          ["Cover", "image/png", "Cover", "png", "image"],
          ["Binary.txt", "application/pdf", "Binary", "pdf", "pdf"],
          ["LICENSE", "application/pdf", "LICENSE", "pdf", "pdf"],
        ];
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
          expect(result).toMatchObject({
            ok: true,
            value: { uri: `uploads://${name}${extension ? `.${extension}` : ""}`, fileType },
          });
          if (!result.ok) throw new Error(result.error.code);
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
        repository: createDrizzleUploadIntakeRepository(database.current),
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

      // Consuming marks the upload used, and only for the chat that owns it.
      const publishedUsed = async () => {
        const [row] = await database.current
          .select({ consumedAt: uploadIntakes.consumedAt })
          .from(uploadIntakes)
          .where(eq(uploadIntakes.documentId, result.value.documentId as never));
        return row?.consumedAt != null;
      };
      expect(await publishedUsed()).toBe(false);
      await service.consume([result.value.documentId], CHAT);
      expect(await publishedUsed()).toBe(false);
      await service.consume([result.value.documentId], NEW_CHAT);
      expect(await publishedUsed()).toBe(true);
    });

    describe("start, PUT, finish", () => {
      const noop = () => ({ ok: true as const });
      type Content = UploadContentPort<null>;

      async function flow(
        overrides: { content?: Partial<Content>; afterHead?: () => Promise<void> } = {},
      ) {
        const repo = await seed();
        const store = createInMemoryObjectStore();
        const hooked: ObjectStorePort = {
          ...store,
          put: store.put.bind(store),
          get: store.get.bind(store),
          delete: store.delete.bind(store),
          list: store.list.bind(store),
          copy: store.copy.bind(store),
          signPut: store.signPut.bind(store),
          getStream: store.getStream.bind(store),
          getSignedUrl: store.getSignedUrl.bind(store),
          async readHead(key, bytes) {
            const head = await store.readHead(key, bytes);
            await overrides.afterHead?.();
            return head;
          },
        };
        const bound: string[] = [];
        const content: Content = {
          names: async () => new Set(),
          bind: async ({ text }) => {
            bound.push(text);
            return { ok: true, bound: null };
          },
          persist: async () => noop(),
          remove: async () => noop(),
          ...overrides.content,
        };
        const intake: UploadIntake = createUploadIntake({
          repository: repo,
          content,
          objectStore: hooked,
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

      it("a delete after finish read the bytes, before the name is claimed, leaves nothing behind and the intake deleted", async () => {
        let deleteNow: () => Promise<unknown> = async () => {};
        const f = await flow({ afterHead: () => deleteNow().then(() => {}) });
        const first = reservedOf(await f.start("race", 8));
        await f.put(first.documentId, f.bytesOf(8));
        deleteNow = () =>
          f.intake.deleteDraft(
            {
              intakeId: "race",
              documentId: first.documentId,
              uri: "uploads://map.pdf",
              expectedRevision: first.locationRevision,
            },
            USER,
            { kind: "chat", projectId: PROJECT, chatId: NEW_CHAT },
          );
        expect(await f.finish("race")).toEqual({
          ok: false,
          error: { code: "idempotency_conflict" },
        });
        expect(await f.keys()).toEqual([]);
        expect(await f.start("race", 8)).toEqual({
          ok: false,
          error: { code: "idempotency_conflict" },
        });
      });

      it("a delete after the name is claimed, before the commit, is not undone by finish", async () => {
        let deleteNow: () => Promise<unknown> = async () => {};
        const f = await flow({
          content: { bind: async () => (await deleteNow(), { ok: true, bound: null }) },
        });
        const first = reservedOf(await f.start("late", 8));
        await f.put(first.documentId, f.bytesOf(8));
        deleteNow = () =>
          f.intake.deleteDraft(
            {
              intakeId: "late",
              documentId: first.documentId,
              uri: "uploads://map.pdf",
              expectedRevision: first.locationRevision,
            },
            USER,
            { kind: "chat", projectId: PROJECT, chatId: NEW_CHAT },
          );
        expect(await f.finish("late")).toEqual({
          ok: false,
          error: { code: "idempotency_conflict" },
        });
        expect(await f.keys()).toEqual([]);
      });

      it("resumes from the stored object when persisting fails, without deleting anything", async () => {
        let fail = true;
        const f = await flow({
          content: { persist: async () => (fail ? { ok: false, conflict: false } : { ok: true }) },
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
