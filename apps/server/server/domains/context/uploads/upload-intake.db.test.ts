/** PostgreSQL conformance for durable upload identity, allocation, and cascade. */
import { createHash } from "node:crypto";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { documents, projects, uploadIntakes, users, works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { drizzleFileAccess } from "../../../test-support/file-grants.js";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import { createTestDocumentLinkScopes } from "../../collab/test-support/document-link-scopes.js";
import { FileEditRefusedError, runWithEditGrants } from "../../file-policy/index.js";
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
    const WORK = "00000000-0000-4000-8000-000000000a03";
    const NO_WORK = "00000000-0000-4000-8000-000000000a04";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    async function seed(db: Database = database.current) {
      await db.insert(users).values(conformanceUserValues(USER, "upload-intake"));
      await db
        .insert(projects)
        .values({ id: PROJECT, userId: USER, name: "Project", slug: "project" });
      await db.insert(works).values([
        {
          id: NO_WORK,
          projectId: PROJECT,
          createdByUserId: USER,
          name: "No Work",
          slug: null,
          isNoWork: true,
        },
        {
          id: WORK,
          projectId: PROJECT,
          createdByUserId: USER,
          name: "Draft",
          slug: "draft",
        },
      ]);
      return createDrizzleUploadIntakeRepository(db);
    }

    const reservation = (
      intakeId: string,
      owner: "none" | "work",
      fingerprint = `fingerprint-${intakeId}`,
    ) => ({
      intakeId,
      actorUserId: USER,
      owner:
        owner === "work"
          ? { kind: "work" as const, projectId: PROJECT, workId: WORK }
          : { kind: "work" as const, projectId: PROJECT, workId: NO_WORK },
      filename: "chapter.md",
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
            links: createTestDocumentLinkScopes(db),
            db,
            documentSync: collab,
            manifestMembership: collab,
            catalogMutations: catalog,
          });
          return createUploadIntake({
            repository: createDrizzleUploadIntakeRepository(db, catalog),
            content: createContextUploadContentPort(contextPorts),
            objectStore,
            eventSink: createNoopEventSink(),
          });
        };
        const content = new TextEncoder().encode("# Concurrent\n");
        const request = {
          ...reservation("concurrent-service", "none"),
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
          value: { uri: "uploads://@/chapter.md", fileType: "markdown" },
        });
      } finally {
        await firstDb.delete(users).where(eq(users.id, USER));
        await Promise.all([firstDb.close(), waiterDb.close()]);
      }
    });

    it("converges idempotency, separates no-Work/Work authority, and suffixes active collisions", async () => {
      const repo = await seed();
      const first = await repo.reserve(reservation("one", "none"));
      const replay = await repo.reserve(reservation("one", "none"));
      const conflict = await repo.reserve(reservation("one", "none", "different"));
      const collision = await repo.reserve(reservation("two", "none"));
      const work = await repo.reserve(reservation("three", "work"));
      expect(first.kind === "reserved" && first.reservation.canonicalUri).toBe(
        "uploads://@/chapter.md",
      );
      expect(replay.kind === "existing" && replay.reservation.documentId).toBe(
        first.kind !== "conflict" && first.kind !== "owner_unavailable"
          ? first.reservation.documentId
          : "",
      );
      expect(conflict).toEqual({ kind: "conflict" });
      expect(collision.kind === "reserved" && collision.reservation.finalPath).toBe(
        "chapter (2).md",
      );
      expect(work.kind === "reserved" && work.reservation.canonicalUri).toBe(
        "uploads://@draft/chapter.md",
      );
    });

    it("deletes only the exact unused identity and preserves revision mismatches", async () => {
      const repo = await seed();
      const reserved = await repo.reserve(reservation("delete", "none"));
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
        extension: "md",
        fileType: "markdown",
      });
      await repo.finalize(PROJECT, "delete");
      const base = {
        intakeId: "delete",
        documentId: identity.documentId,
        uri: identity.canonicalUri,
      };
      expect((await repo.deleteDraft({ ...base, expectedRevision: "wrong" }, USER)).result).toEqual(
        { kind: "identity_mismatch" },
      );
      expect(
        (await repo.deleteDraft({ ...base, expectedRevision: identity.locationRevision }, USER))
          .result,
      ).toEqual({ kind: "deleted" });
      expect(
        (await repo.deleteDraft({ ...base, expectedRevision: identity.locationRevision }, USER))
          .result,
      ).toEqual({ kind: "already_deleted" });
      expect(
        await database.current
          .select()
          .from(documents)
          .where(eq(documents.id, identity.documentId as never)),
      ).toEqual([]);
    });

    it("refuses a draft delete under a grant its archived Work no longer holds", async () => {
      const repo = await seed();
      const reserved = await repo.reserve(reservation("archived", "work"));
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
        extension: "md",
        fileType: "markdown",
      });
      await repo.finalize(PROJECT, "archived");
      const access = drizzleFileAccess(database.current);
      const grant = await access.authorize(
        { accountId: USER as never },
        { kind: "document", documentId: identity.documentId as never },
        "edit",
      );
      if ("denied" in grant) throw new Error("edit grant expected before archiving");
      await database.current
        .update(works)
        .set({ archivedAt: new Date() })
        .where(eq(works.id, WORK));

      const outcome = await runWithEditGrants(access, [grant], () =>
        repo.deleteDraft(
          {
            intakeId: "archived",
            documentId: identity.documentId,
            uri: identity.canonicalUri,
            expectedRevision: identity.locationRevision,
          },
          USER,
        ),
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal).toBeInstanceOf(FileEditRefusedError);
      expect(
        await database.current
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, identity.documentId as never)),
      ).toHaveLength(1);
      const [after] = await database.current
        .select({ state: uploadIntakes.state })
        .from(uploadIntakes)
        .where(eq(uploadIntakes.documentId, identity.documentId as never));
      expect(after?.state).toBe("finalized");
    });

    it("finalizes tracked Yjs content and catalog identity in the authoritative boundary", async () => {
      await seed();
      const collab = createInMemoryCollabDomain();
      const catalog = createDrizzleContextCatalog(database.current);
      const contextPorts = createProductionUnifiedContextPortFactory({
        links: createTestDocumentLinkScopes(database.current),
        db: database.current,
        documentSync: collab,
        manifestMembership: collab,
        catalogMutations: catalog,
      });
      const service = createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(database.current, catalog),
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
      });
      const content = new TextEncoder().encode("# Chapter One\n\nIt began.");
      const result = await service.intake({
        ...reservation("tracked", "none"),
        bytes: content,
        byteDigest: createHash("sha256").update(content).digest("hex"),
      });
      if (!result.ok) throw new Error(result.error.code);
      expect(await collab.readAsMarkdown(result.value.documentId as never)).toEqual({
        ok: true,
        value: "# Chapter One\n\nIt began.\n",
      });
      const snapshot = await catalog.snapshot({
        kind: "work",
        projectId: PROJECT as never,
        workId: NO_WORK as never,
      });
      expect(snapshot.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entryId: result.value.documentId,
            uri: "uploads://@/chapter.md",
          }),
        ]),
      );
    });
  });
}
