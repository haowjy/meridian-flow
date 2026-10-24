/**
 * PostgreSQL conformance for durable upload identity, allocation, and cascade.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - MIME and extension precedence for canonical upload names and Markdown conversion
 */

import { createHash } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextCatalogEntries,
  contextSources,
  documents,
  projects,
  threads,
  uploadIntakes,
  users,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDocumentRemoval,
  createTestRemovalDeps,
} from "../../../test-support/document-removal.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createCollabDomain } from "../../collab/composition.js";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import {
  createTestDocumentLinkScopes,
  testLinkDeps,
} from "../../collab/test-support/document-link-scopes.js";
import { createAllowAllFileAccess } from "../../file-policy/index.js";
import { createNoopEventSink } from "../../observability/index.js";
import { createInMemoryObjectStore } from "../../storage/index.js";
import { createDrizzleContextCatalog } from "../adapters/context-catalog.js";
import { createProductionUnifiedContextPortFactory } from "../unified-context-port-factory.js";
import { createContextUploadContentPort } from "./context-upload-content.js";
import { createDrizzleUploadIntakeRepository } from "./drizzle-upload-intake.js";
import { createUploadIntake } from "./upload-intake.js";

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
      return createDrizzleUploadIntakeRepository(db);
    }

    /** Deletion through the aggregate; `removed` records arrived uploads it soft-deleted. */
    function deletion(repository: ReturnType<typeof createDrizzleUploadIntakeRepository>) {
      const removed: string[] = [];
      const intake = createUploadIntake({
        repository,
        content: {
          bind: async () => ({ ok: true, bound: null }),
          persist: async () => ({ ok: true }),
          async remove({ reservation }) {
            removed.push(reservation.documentId);
            return { ok: true };
          },
        },
        objectStore: createInMemoryObjectStore(),
        eventSink: createNoopEventSink(),
        catalog: { refreshSources: async () => "1" },
      });
      return { removed, deleteDraft: intake.deleteDraft };
    }

    const reservation = (
      intakeId: string,
      chatId: string,
      fingerprint = `fingerprint-${intakeId}`,
    ) => ({
      intakeId,
      actorUserId: USER,
      owner: { kind: "chat" as const, projectId: PROJECT, chatId },
      filename: "chapter.md",
      documentFilename: { name: "chapter", extension: "", filetype: "markdown" as const },
      mimeType: "text/markdown",
      byteDigest: "a".repeat(64),
      fingerprint,
      fileType: "markdown" as const,
    });

    it("converges concurrent production service calls on the authoritative trio", async () => {
      const firstDb = createDb(DATABASE_URL);
      const waiterDb = createDb(DATABASE_URL);
      try {
        await seed(firstDb);
        const collab = createInMemoryCollabDomain();
        const objectStore = createInMemoryObjectStore();
        const service = (db: Database) => {
          const catalog = createDrizzleContextCatalog(db);
          const contextPorts = createProductionUnifiedContextPortFactory({
            pendingBranch: createTestWorkProjectionMutation(db),
            links: createTestDocumentLinkScopes(db),
            db,
            removal: createTestDocumentRemoval(db),
            documentSync: collab,
            branches: collab.branches,
            catalogMutations: catalog,
          });
          return createUploadIntake({
            repository: createDrizzleUploadIntakeRepository(db),
            content: createContextUploadContentPort(contextPorts),
            objectStore,
            eventSink: createNoopEventSink(),
            catalog: { refreshSources: async () => "1" },
          });
        };
        const content = new TextEncoder().encode("# Concurrent\n");
        const request = {
          ...reservation("concurrent-service", NEW_CHAT),
          bytes: content,
          byteDigest: createHash("sha256").update(content).digest("hex"),
        };

        // Settle both calls before `finally` deletes the user: a rejected
        // Promise.all would leave the other transaction running into the delete.
        const settled = await Promise.allSettled([
          service(firstDb).intake(request),
          service(waiterDb).intake(request),
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
      } finally {
        await firstDb.delete(users).where(eq(users.id, USER));
        await Promise.all([firstDb.close(), waiterDb.close()]);
      }
    });

    it("converges idempotency, derives the address from the chat's handle, and suffixes active collisions", async () => {
      const repo = await seed();
      const first = await repo.reserve(reservation("one", NEW_CHAT));
      const replay = await repo.reserve(reservation("one", NEW_CHAT));
      const conflict = await repo.reserve(reservation("one", NEW_CHAT, "different"));
      const collision = await repo.reserve(reservation("two", NEW_CHAT));
      const existingChat = await repo.reserve(reservation("three", CHAT));
      expect(first.kind === "reserved" && first.reservation.canonicalUri).toBe("uploads://chapter");
      expect(replay.kind === "existing" && replay.reservation.documentId).toBe(
        first.kind !== "conflict" && first.kind !== "owner_unavailable"
          ? first.reservation.documentId
          : "",
      );
      expect(conflict).toEqual({ kind: "conflict" });
      expect(collision.kind === "reserved" && collision.reservation.finalPath).toBe("chapter (2)");
      expect(existingChat.kind === "reserved" && existingChat.reservation.canonicalUri).toBe(
        "uploads://@c1/chapter",
      );
      // The New chat gets its row, and so its handle, at Send: the same upload now reads there.
      await database.current.insert(threads).values({
        id: NEW_CHAT,
        projectId: PROJECT,
        rootThreadId: NEW_CHAT,
        createdByUserId: USER,
        ref: "c2",
      });
      const afterSend = await repo.reserve(reservation("one", NEW_CHAT));
      expect(afterSend.kind === "existing" && afterSend.reservation.canonicalUri).toBe(
        "uploads://@c2/chapter",
      );
    });

    it("deletes only the exact unused identity and preserves revision mismatches", async () => {
      const repo = await seed();
      const reserved = await repo.reserve(reservation("delete", NEW_CHAT));
      if (reserved.kind === "conflict" || reserved.kind === "owner_unavailable") {
        throw new Error("reservation failed");
      }
      const identity = reserved.reservation;
      const [intake] = await database.current
        .select()
        .from(uploadIntakes)
        .where(eq(uploadIntakes.documentId, identity.documentId as never));
      if (!intake) throw new Error("intake missing");
      await database.current.insert(documents).values({
        id: identity.documentId as never,
        contextSourceId: intake.contextSourceId,
        name: "chapter",
        extension: "",
        fileType: "markdown",
      });
      await repo.finalize(PROJECT, "delete");
      const base = {
        intakeId: "delete",
        documentId: identity.documentId,
        uri: identity.canonicalUri,
      };
      const { removed, deleteDraft } = deletion(repo);
      expect(await deleteDraft({ ...base, expectedRevision: "wrong" }, USER)).toEqual({
        kind: "identity_mismatch",
      });
      expect(
        await deleteDraft({ ...base, expectedRevision: identity.locationRevision }, USER),
      ).toEqual({ kind: "deleted" });
      expect(
        await deleteDraft({ ...base, expectedRevision: identity.locationRevision }, USER),
      ).toEqual({ kind: "already_deleted" });
      // An arrived upload leaves through the canonical soft delete, never a hard delete.
      expect(removed).toEqual([identity.documentId]);
      expect(
        await database.current
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, identity.documentId as never)),
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
          adapterType: "local",
        });
        const catalog = createDrizzleContextCatalog(db);
        const collab = createCollabDomain({
          ...testLinkDeps(db),
          db: db,
          ...createTestRemovalDeps(db),
          fileAccess: createAllowAllFileAccess(),
          workProjectionMutation: createTestWorkProjectionMutation(db),
          catalogMutations: catalog,
        });
        collab.bindHocuspocus(
          new Hocuspocus({
            yDocOptions: { gc: false, gcFilter: () => true },
            onStoreDocument: ({ documentName, document }) =>
              collab.storeHocuspocusDocument(documentName, document),
          }),
        );
        const contextPorts = createProductionUnifiedContextPortFactory({
          pendingBranch: createTestWorkProjectionMutation(db),
          links: createTestDocumentLinkScopes(db),
          db: db,
          removal: createTestDocumentRemoval(db),
          documentSync: collab,
          branches: collab.branches,
          catalogMutations: catalog,
        });
        const service = createUploadIntake({
          repository: createDrizzleUploadIntakeRepository(db),
          content: createContextUploadContentPort(contextPorts),
          objectStore: createInMemoryObjectStore(),
          eventSink: createNoopEventSink(),
          catalog: { refreshSources: async () => "1" },
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
          const result = await service.intake({
            ...reservation(filename, NEW_CHAT),
            filename,
            mimeType,
            bytes: content,
            byteDigest: createHash("sha256").update(content).digest("hex"),
          });
          expect(result).toMatchObject({
            ok: true,
            value: { uri: `uploads://${name}${extension ? `.${extension}` : ""}`, fileType },
          });
          if (!result.ok) throw new Error(result.error.code);
          const [document] = await db
            .select()
            .from(documents)
            .where(eq(documents.id, result.value.documentId as never));
          expect(document).toMatchObject({ name, extension, fileType });
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
      const catalog = createDrizzleContextCatalog(database.current);
      const contextPorts = createProductionUnifiedContextPortFactory({
        pendingBranch: createTestWorkProjectionMutation(database.current),
        links: createTestDocumentLinkScopes(database.current),
        db: database.current,
        removal: createTestDocumentRemoval(database.current),
        documentSync: collab,
        branches: collab.branches,
        catalogMutations: catalog,
      });
      const service = createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(database.current),
        content: createContextUploadContentPort(contextPorts),
        objectStore: {
          async put() {
            return { ok: true, value: { storageUrl: "object://unused" } };
          },
          async delete() {
            return { ok: true, value: undefined };
          },
          async get() {
            return { ok: false, error: { code: "not_found", message: "missing" } };
          },
          async list() {
            return { ok: true, value: { keys: [] } };
          },
          async getSignedUrl() {
            return { ok: false, error: { code: "not_found", message: "missing" } };
          },
        },
        eventSink: createNoopEventSink(),
        catalog,
      });
      const content = new TextEncoder().encode("# Chapter One\n\nIt began.");
      const result = await service.intake({
        ...reservation("tracked", NEW_CHAT),
        bytes: content,
        byteDigest: createHash("sha256").update(content).digest("hex"),
      });
      if (!result.ok) throw new Error(result.error.code);
      expect(await collab.readAsMarkdown(result.value.documentId as never)).toEqual({
        ok: true,
        value: "# Chapter One\n\nIt began.\n",
      });
      const [stored] = await database.current
        .select({ chatThreadId: contextSources.chatThreadId })
        .from(documents)
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .where(eq(documents.id, result.value.documentId as never));
      expect(stored?.chatThreadId).toBe(NEW_CHAT);

      // Consumption republishes the upload's facts, so a reader on the delta stream sees `used`.
      const publishedUsed = async () => {
        const [row] = await database.current
          .select({ entry: contextCatalogEntries.entry })
          .from(contextCatalogEntries)
          .where(eq(contextCatalogEntries.entryId, result.value.documentId));
        return row?.entry.kind === "file" ? row.entry.upload?.used : undefined;
      };
      expect(await publishedUsed()).toBe(false);
      await service.consume([result.value.documentId], CHAT);
      expect(await publishedUsed()).toBe(false);
      await service.consume([result.value.documentId], NEW_CHAT);
      expect(await publishedUsed()).toBe(true);
    });
  });
}
