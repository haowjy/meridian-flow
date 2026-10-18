/** Seeded upgrade contract: normalize historical content and every mutable address. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextCatalogCommits,
  contextCatalogEntries,
  contextCatalogScopeHeads,
  contextSources,
  documentLinks,
  documentPreviousLocations,
  documents,
  folders,
  linkAheadRefs,
  projects,
  projectUserWorkingSets,
  uploadIntakes,
  users,
  works,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { useRollbackTestDatabase } from "../../../../test-support/drizzle-reset.js";
import { createTestWorkProjectionMutation } from "../../../../test-support/work-projection.js";
import { createInMemoryCollabDomain } from "../../../collab/index.js";
import { createTestDocumentLinkScopes } from "../../../collab/test-support/document-link-scopes.js";
import { createNoopEventSink } from "../../../observability/index.js";
import { createInMemoryObjectStore } from "../../../storage/index.js";
import { createProductionUnifiedContextPortFactory } from "../../unified-context-port-factory.js";
import { createContextUploadContentPort } from "../../uploads/context-upload-content.js";
import { createDrizzleUploadIntakeRepository } from "../../uploads/drizzle-upload-intake.js";
import { createUploadIntake } from "../../uploads/upload-intake.js";
import { createDrizzleContextCatalog } from "../context-catalog.js";
import { guardWorkContextRestore } from "./document-locations.js";

/**
 * Replays 0037 over rows seeded in today's schema. It ran before the Work-branch foundation
 * dropped `documents.kind` (0039), so the replay restores that column for its duration,
 * inside the test's rolled-back transaction. The populated upgrade through 0037 and the
 * foundation in deploy order is `work-branch-foundation-migration.db.test.ts`.
 */
async function migrate(db: import("@meridian/database").Database) {
  await db.execute(sql`ALTER TABLE documents ADD COLUMN kind text NOT NULL DEFAULT 'content'`);
  // 0037 also rewrote `upload_intakes.canonical_uri`, which 0060 retired.
  await db.execute(
    sql`ALTER TABLE upload_intakes ADD COLUMN canonical_uri text NOT NULL DEFAULT ''`,
  );
  await db.execute(sql`UPDATE upload_intakes SET canonical_uri = 'uploads://@/' || final_path`);
  const migration = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../../../packages/database/src/migrations/0037_old_adam_destine.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
  await db.execute(sql`ALTER TABLE documents DROP COLUMN kind`);
  await db.execute(sql`ALTER TABLE upload_intakes DROP COLUMN canonical_uri`);
}

const enabled = process.env.RUN_DB_TESTS === "1" && process.env.DATABASE_URL;
if (!enabled) describe.skip("document name migration", () => {});
else
  describe("document name migration", () => {
    const database = useRollbackTestDatabase(enabled);
    it("preserves prose, allocates collision names, and updates deleted rows, aliases and ahead refs", async () => {
      const db = database.current;
      const userId = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const sourceId = crypto.randomUUID();
      await db.insert(users).values(conformanceUserValues(userId, "document-names-migration"));
      await db.insert(projects).values({ id: projectId, userId, name: "Naming", slug: "naming" });
      await db.insert(contextSources).values({
        id: sourceId,
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(folders).values({ contextSourceId: sourceId, name: "Lore.md" });
      const fixtures = [
        ["chapter", "md", "markdown", "chapter"],
        ["notes", "txt", "text", "notes"],
        ["long", "markdown", "markdown", "long"],
        ["plain", "", "markdown", "plain"],
        ["Vol", " 2", "text", "Vol. 2"],
        ["data.json", "md", "markdown", "data.json (2)"],
        ["twin", "", "markdown", "twin"],
        ["twin", "md", "markdown", "twin (3)"],
        ["twin (2)", "md", "markdown", "twin (2)"],
        ["Lore", "md", "markdown", "Lore (2)"],
        ["gone", "TXT", "text", "gone"],
        ["config", "TOML", "text", "config"],
      ];
      const rows = fixtures.map(([name, extension, fileType]) => ({
        id: crypto.randomUUID(),
        contextSourceId: sourceId,
        name: name ?? "",
        extension,
        fileType,
        deletedAt: name === "gone" ? new Date() : null,
      }));
      await db.insert(documents).values(rows);
      const chapter = rows[0];
      if (!chapter) throw new Error("fixture missing");
      await db
        .insert(documentPreviousLocations)
        .values({ contextSourceId: sourceId, documentId: chapter.id, path: "before/chapter.md" });
      await db.insert(linkAheadRefs).values({
        aheadId: crypto.randomUUID(),
        projectId,
        scheme: "manuscript",
        path: "chapter.md",
        settledDocumentId: chapter.id,
      });
      await db.insert(documentLinks).values({
        sourceDocumentId: chapter.id,
        linkKey: `doc:${chapter.id}`,
        targetDocumentId: chapter.id,
        address: "manuscript://chapter.md",
        occurrences: 1,
      });
      const workId = crypto.randomUUID();
      const workSourceId = crypto.randomUUID();
      const hiddenDocId = crypto.randomUUID();
      const hiddenAheadId = crypto.randomUUID();
      const deletedAt = new Date();
      await db.insert(works).values({
        id: workId,
        projectId,
        createdByUserId: userId,
        name: "Upgrade",
        slug: "upgrade",
        deletedAt,
      });
      await db.insert(contextSources).values({
        id: workSourceId,
        workId,
        name: "Scratch",
        slug: "scratch",
        scope: "work",
        deletedAt,
        deletedByWorkId: workId,
      });
      await db.insert(folders).values({
        contextSourceId: workSourceId,
        name: "Lore.md",
        deletedAt,
        deletedByWorkId: workId,
      });
      await db.insert(documents).values({
        id: hiddenDocId,
        contextSourceId: workSourceId,
        name: "Lore",
        extension: "md",
        fileType: "markdown",
        deletedAt,
        deletedByWorkId: workId,
      });
      await db
        .insert(linkAheadRefs)
        .values({ aheadId: hiddenAheadId, projectId, scheme: "scratch", workId, path: "Lore.md" });
      await db.insert(documentLinks).values({
        sourceDocumentId: chapter.id,
        linkKey: `ahead:${hiddenAheadId}`,
        aheadId: hiddenAheadId,
        address: "scratch://@upgrade/Lore.md",
        occurrences: 1,
      });
      const scopeKey = `project:${projectId}`;
      await db.insert(contextCatalogScopeHeads).values({
        scopeKey,
        scope: { kind: "project", projectId: projectId as never },
        headRevision: 1,
      });
      const [oldHead] = await db
        .select()
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      const cachedEntry = {
        observationVersion: "1",
        kind: "file" as const,
        entryId: chapter.id as never,
        scope: { kind: "project" as const, projectId: projectId as never },
        sourceId: sourceId as never,
        parentId: sourceId as never,
        name: "chapter.md",
        aliases: [],
        path: ["chapter.md"],
        uri: "manuscript://chapter.md" as never,
        provisionalName: false,
        editable: true as const,
        filetype: "markdown" as const,
        schemaType: "document" as const,
      };
      await db
        .insert(contextCatalogEntries)
        .values({ scopeKey, entryId: chapter.id, entry: cachedEntry });
      await db.insert(contextCatalogCommits).values({
        commitId: crypto.randomUUID(),
        scopeKey,
        firstRevision: 1,
        lastRevision: 1,
        changes: [{ operation: "upsert", ordinal: 0, entry: cachedEntry }],
      });
      await db.insert(uploadIntakes).values({
        projectId,
        intakeId: "historical",
        actorUserId: userId,
        ownerThreadId: crypto.randomUUID(),
        contextSourceId: sourceId,
        documentId: chapter.id,
        fingerprint: "fixture",
        byteDigest: "a".repeat(64),
        filename: "chapter.md",
        mimeType: "text/markdown",
        finalPath: "chapter.md",
        objectKey: "fixture",
        fileType: "markdown",
        locationRevision: crypto.randomUUID(),
        state: "finalized",
      });
      const hiddenTwinIds = [crypto.randomUUID(), crypto.randomUUID()];
      await db.insert(documents).values(
        hiddenTwinIds.map((id, index) => ({
          id,
          contextSourceId: workSourceId,
          name: "hidden-twin",
          extension: index === 0 ? "md" : "txt",
          fileType: "markdown",
          deletedAt,
          deletedByWorkId: workId,
        })),
      );
      const binaryId = crypto.randomUUID();
      await db.insert(documents).values({
        id: binaryId,
        contextSourceId: sourceId,
        name: "Binary",
        extension: "txt",
        fileType: "pdf",
        mimeType: "application/pdf",
        storageUrl: "s3://fixture",
      });
      await db.insert(projectUserWorkingSets).values({
        userId,
        projectId,
        revision: 7,
        recentRoutes: [
          { documentId: chapter.id as never, scheme: "manuscript", path: "chapter.md" },
        ],
      });
      await migrate(db);
      await expect(guardWorkContextRestore(db, workId)).resolves.toBeUndefined();
      const hiddenTwins = await db
        .select()
        .from(documents)
        .where(sql`${documents.id} IN (${hiddenTwinIds[0]}, ${hiddenTwinIds[1]})`);
      expect(new Set(hiddenTwins.map((row) => row.name))).toEqual(
        new Set(["hidden-twin", "hidden-twin (2)"]),
      );
      // Unhide the arriving set just as Work restore does: the DB unique indexes must accept it.
      await db
        .update(documents)
        .set({ deletedAt: null, deletedByWorkId: null })
        .where(eq(documents.deletedByWorkId, workId));
      await db
        .update(folders)
        .set({ deletedAt: null, deletedByWorkId: null })
        .where(eq(folders.deletedByWorkId, workId));
      expect(
        (await db.select().from(documents).where(eq(documents.id, binaryId)))[0],
      ).toMatchObject({ name: "Binary", extension: "pdf", fileType: "pdf" });
      expect(
        (
          await db
            .select()
            .from(projectUserWorkingSets)
            .where(eq(projectUserWorkingSets.projectId, projectId))
        )[0],
      ).toMatchObject({
        revision: 8,
        recentRoutes: [{ documentId: chapter.id, scheme: "manuscript", path: "chapter" }],
      });

      const stored = await db
        .select()
        .from(documents)
        .where(eq(documents.contextSourceId, sourceId));
      for (const [index, fixture] of fixtures.entries()) {
        const row = stored.find((row) => row.id === rows[index]?.id);
        expect(row).toMatchObject({
          name: fixture[3],
          extension: fixture[1] === "TOML" ? "toml" : "",
          fileType: fixture[1] === "TOML" ? "text" : "markdown",
        });
      }
      expect(
        (
          await db
            .select()
            .from(documentPreviousLocations)
            .where(eq(documentPreviousLocations.contextSourceId, sourceId))
        )[0]?.path,
      ).toBe("before/chapter");
      expect(
        (
          await db
            .select()
            .from(linkAheadRefs)
            .where(eq(linkAheadRefs.settledDocumentId, chapter.id))
        )[0]?.path,
      ).toBe("chapter");
      const links = await db
        .select()
        .from(documentLinks)
        .where(eq(documentLinks.sourceDocumentId, chapter.id));
      expect(links.find((link) => link.targetDocumentId === chapter.id)?.address).toBe(
        "manuscript://chapter",
      );
      expect(links.find((link) => link.aheadId === hiddenAheadId)?.address).toBe(
        "scratch://@upgrade/Lore (2)",
      );
      expect(
        (await db.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, hiddenAheadId)))[0]
          ?.path,
      ).toBe("Lore (2)");
      expect(
        (await db.select().from(documents).where(eq(documents.id, hiddenDocId)))[0],
      ).toMatchObject({ name: "Lore (2)", extension: "", deletedByWorkId: null });
      expect(
        (await db.select().from(uploadIntakes).where(eq(uploadIntakes.documentId, chapter.id)))[0],
      ).toMatchObject({
        finalPath: "chapter",
        filename: "chapter.md",
      });
      expect(
        await db
          .select()
          .from(contextCatalogEntries)
          .where(eq(contextCatalogEntries.scopeKey, scopeKey)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(contextCatalogCommits)
          .where(eq(contextCatalogCommits.scopeKey, scopeKey)),
      ).toHaveLength(0);
      const [head] = await db
        .select()
        .from(contextCatalogScopeHeads)
        .where(eq(contextCatalogScopeHeads.scopeKey, scopeKey));
      expect(head?.generation).not.toBe(oldHead?.generation);
      expect(head?.headRevision).toBe(0);
      expect(stored.find((row) => row.name === "gone")?.deletedAt).not.toBeNull();
    });

    it.each([
      "clash",
      "no-clash",
      "control",
    ])("canonicalizes pending reservation (%s)", async (scenario) => {
      const db = database.current;
      const userId = crypto.randomUUID(),
        projectId = crypto.randomUUID(),
        sourceId = crypto.randomUUID(),
        documentId = crypto.randomUUID(),
        chatId = crypto.randomUUID();
      const bytes = new TextEncoder().encode("# Pending upload\n");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            userId,
            `chat:${projectId}:${chatId}`,
            "upload.md",
            "text/markdown",
            digest,
          ]),
        )
        .digest("hex");
      await db.insert(users).values(conformanceUserValues(userId, `pending-${scenario}`));
      await db.insert(projects).values({ id: projectId, userId, name: "Pending", slug: "pending" });
      await db.insert(contextSources).values({
        id: sourceId,
        projectId,
        chatThreadId: chatId,
        name: "Uploads",
        slug: "uploads",
        scope: "chat",
      });
      if (scenario !== "no-clash")
        await db.insert(documents).values({
          contextSourceId: sourceId,
          name: "upload",
          extension: "txt",
          fileType: "text",
        });
      const oldPath = scenario === "control" ? "upload" : "upload.md";
      await db.insert(uploadIntakes).values({
        projectId,
        intakeId: "pending",
        actorUserId: userId,
        contextSourceId: sourceId,
        documentId,
        ownerThreadId: chatId,
        fingerprint,
        byteDigest: digest,
        filename: "upload.md",
        mimeType: "text/markdown",
        finalPath: oldPath,
        objectKey: documentId,
        fileType: "markdown",
        locationRevision: crypto.randomUUID(),
        state: "reserved",
      });
      await migrate(db);
      const [reservation] = await db
        .select()
        .from(uploadIntakes)
        .where(eq(uploadIntakes.documentId, documentId));
      expect(reservation?.finalPath).toBe(scenario === "clash" ? "upload (2)" : "upload");
      expect(reservation?.filename).toBe("upload.md");
      expect(reservation?.state).toBe("reserved");
      const collab = createInMemoryCollabDomain();
      const contextPorts = createProductionUnifiedContextPortFactory({
        pendingBranch: createTestWorkProjectionMutation(db),
        db,
        links: createTestDocumentLinkScopes(db),
        documentSync: collab,
        branches: collab.branches,
        catalogMutations: createDrizzleContextCatalog(db),
      });
      const service = createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(db),
        content: createContextUploadContentPort(contextPorts),
        objectStore: createInMemoryObjectStore(),
        eventSink: createNoopEventSink(),
        catalog: { refreshSources: async () => "1" },
      });
      const request = {
        intakeId: "pending",
        actorUserId: userId,
        owner: { kind: "chat" as const, projectId, chatId },
        filename: "upload.md",
        mimeType: "text/markdown",
        byteDigest: digest,
        bytes,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await service.intake(request)).toMatchObject({
          ok: true,
          value: { documentId },
        });
      }
      const [committed] = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(committed?.name).toBe(reservation?.finalPath);
      expect(committed?.extension).toBe("");
    });
    it.each([
      "pending",
      "case-folded",
    ])("allocates around %s upload intake reservations", async (scenario) => {
      const db = database.current;
      const userId = crypto.randomUUID(),
        projectId = crypto.randomUUID(),
        chatId = crypto.randomUUID(),
        sourceId = crypto.randomUUID();
      await db.insert(users).values(conformanceUserValues(userId, `migration-upload-${scenario}`));
      await db
        .insert(projects)
        .values({ id: projectId, userId, name: "Uploads", slug: `uploads-${scenario}` });
      await db.insert(contextSources).values({
        id: sourceId,
        projectId,
        chatThreadId: chatId,
        name: "Uploads",
        slug: "uploads",
        scope: "chat",
      });
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      const paths = scenario === "pending" ? ["upload.md", "upload"] : ["Report.md", "report.txt"];
      const firstName = scenario === "pending" ? "upload" : "Report";
      await db.insert(documents).values({
        id: ids[0],
        contextSourceId: sourceId,
        name: firstName,
        extension: "md",
        fileType: "markdown",
      });
      if (scenario === "case-folded")
        await db.insert(documents).values({
          id: ids[1],
          contextSourceId: sourceId,
          name: "report",
          extension: "txt",
          fileType: "text",
        });
      await db.insert(uploadIntakes).values(
        ids.map((id, index) => ({
          projectId,
          intakeId: `intake-${index}`,
          actorUserId: userId,
          ownerThreadId: chatId,
          contextSourceId: sourceId,
          documentId: id,
          fingerprint: "fixture",
          byteDigest: "a".repeat(64),
          filename: paths[index] ?? "",
          mimeType: "text/plain",
          finalPath: paths[index] ?? "",
          objectKey: id,
          fileType: "markdown",
          locationRevision: crypto.randomUUID(),
          state: index === 1 && scenario === "pending" ? "reserved" : "finalized",
        })),
      );
      await migrate(db);
      const intakes = await db
        .select()
        .from(uploadIntakes)
        .where(eq(uploadIntakes.contextSourceId, sourceId));
      expect(new Set(intakes.map((row) => row.finalPath.toLowerCase())).size).toBe(2);
      const migrated = await db
        .select()
        .from(documents)
        .where(eq(documents.contextSourceId, sourceId));
      for (const row of migrated) {
        const intake = intakes.find((intake) => intake.documentId === row.id);
        expect(intake?.finalPath).toBe(row.name);
      }
      if (scenario === "pending") {
        expect(migrated[0]?.name).toBe("upload (2)");
        expect(intakes.find((row) => row.documentId === ids[1])?.finalPath).toBe("upload");
      } else {
        expect(migrated.map((row) => row.name.replace(/ \(2\)$/, "").toLowerCase())).toEqual([
          "report",
          "report",
        ]);
        expect(migrated.filter((row) => row.name.endsWith(" (2)"))).toHaveLength(1);
      }
    });
  });
