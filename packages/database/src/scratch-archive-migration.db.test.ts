/** Populated 0031 upgrade contract: Scratch archival and interrupted online DDL. */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type Database } from "@meridian/database";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { ContextCatalog } from "../../../apps/server/server/domains/context/ports/context-catalog.js";
import type { UploadIntakeRepository } from "../../../apps/server/server/domains/context/uploads/upload-intake.js";
import { runMigrations } from "../../../tools/dev/lib/migration-runner.js";
import {
  archiveNoteState,
  archiveId as id,
  seedScratchArchive,
} from "./__test-support__/scratch-archive-fixture.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("Scratch archival migration (postgres)", () => {
  it("preserves identities, bytes and trash, rebuilds catalogs, and retries every online swap cut", async () => {
    const target = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
    const db = createDb(databaseUrl ?? "", { max: 1 });
    const directory = await mkdtemp(path.join(tmpdir(), "meridian-scratch-archive-"));
    const migrations = path.join(import.meta.dirname, "migrations");
    const journal = JSON.parse(await readFile(path.join(migrations, "meta/_journal.json"), "utf8"));
    let isolated = false;
    try {
      await target.begin(async (tx) => {
        await tx`ALTER SCHEMA public RENAME TO scratch_archive_saved_public`;
        await tx`ALTER SCHEMA drizzle RENAME TO scratch_archive_saved_drizzle`;
        await tx`CREATE SCHEMA public`;
        await tx`ALTER EXTENSION pg_trgm SET SCHEMA public`;
      });
      isolated = true;
      await cp(migrations, directory, { recursive: true });
      for (const entry of journal.entries.slice(32))
        await rm(path.join(directory, `${entry.tag}.sql`));
      await writeFile(
        path.join(directory, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 32) }),
      );
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      await seedScratchArchive(target);
      const before =
        await target`SELECT id, markdown_projection, metadata, deleted_at FROM documents ORDER BY id`;
      const yjs = await target`SELECT * FROM document_yjs_heads`;
      const checkpoints = await target`SELECT * FROM document_yjs_checkpoints ORDER BY id`;
      const updates = await target`SELECT * FROM document_yjs_updates`;
      for (const entry of journal.entries.slice(32, 34))
        await cp(
          path.join(migrations, `${entry.tag}.sql`),
          path.join(directory, `${entry.tag}.sql`),
        );
      await writeFile(
        path.join(directory, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 34) }),
      );
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      expect(
        await target`SELECT id, markdown_projection, metadata, deleted_at FROM documents ORDER BY id`,
      ).toEqual(before);
      expect(await target`SELECT * FROM document_yjs_heads`).toEqual(yjs);
      expect(await target`SELECT * FROM document_yjs_updates`).toEqual(updates);
      expect(await target`SELECT * FROM document_yjs_checkpoints ORDER BY id`).toEqual(checkpoints);
      expect(
        (await target`SELECT state FROM document_yjs_checkpoints WHERE document_id = ${id(14)}`)[0]
          ?.state,
      ).toEqual(archiveNoteState);
      expect(await target`SELECT document_id FROM user_recent_documents`).toEqual([
        { document_id: id(14) },
      ]);
      expect(await target`SELECT id FROM context_sources WHERE id IN (${id(6)}, ${id(7)})`).toEqual(
        [],
      );
      expect(
        await target`SELECT context_source_id, path, document_id FROM document_previous_locations ORDER BY path`,
      ).toEqual([
        {
          context_source_id: id(8),
          path: "Scratch (2)/nested/deep/trashed-leaf.md",
          document_id: id(18),
        },
        {
          context_source_id: id(8),
          path: "Scratch (2)/trashed-folder/hidden-note.md",
          document_id: id(18),
        },
        {
          context_source_id: id(8),
          path: "Scratch (2)/trashed-folder/trashed-note.md",
          document_id: id(18),
        },
        { context_source_id: id(8), path: "unrelated-alias.md", document_id: id(18) },
      ]);
      expect(await target`SELECT * FROM context_catalog_scope_heads`).toEqual([]);
      expect(await target`SELECT * FROM context_catalog_entries`).toEqual([]);
      expect(await target`SELECT * FROM context_catalog_commits`).toEqual([]);
      expect(
        await target`SELECT f.name FROM folders f JOIN context_sources s ON s.id = f.context_source_id WHERE s.slug = 'unfiled' AND s.project_id = ${id(3)} AND f.parent_id IS NULL`,
      ).toEqual([{ name: "Scratch" }]);
      expect(
        await target`SELECT f.name FROM documents d JOIN folders f ON f.id = d.folder_id WHERE d.id = ${id(15)}`,
      ).toEqual([{ name: "Scratch (2)" }]);
      expect(await target`SELECT parent_id FROM folders WHERE id = ${id(12)}`).toEqual([
        { parent_id: id(11) },
      ]);
      expect(await target`SELECT folder_id FROM documents WHERE id = ${id(16)}`).toEqual([
        { folder_id: id(13) },
      ]);
      // Exercise the actual lifecycle reader, not just the migrated row shape.
      const { createDrizzleUploadIntakeRepository } = (await import(
        new URL(
          "../../../apps/server/server/domains/context/uploads/drizzle-upload-intake.ts",
          import.meta.url,
        ).href
      )) as { createDrizzleUploadIntakeRepository(db: Database): UploadIntakeRepository };
      const intakeRepository = createDrizzleUploadIntakeRepository(db);
      const reservation = await intakeRepository.transaction(() =>
        intakeRepository.lockForFinalize(id(2), "reserved-intake"),
      );
      expect(reservation).toMatchObject({
        state: "reserved",
        owner: { kind: "work", workId: id(4), workSlug: null },
        canonicalUri: "unfiled://Scratch (2)/map.png",
        finalPath: "Scratch (2)/map.png",
        objectKey: `uploads/${id(2)}/${id(21)}`,
      });
      expect(
        await intakeRepository.transaction(() =>
          intakeRepository.finalize(id(2), "reserved-intake"),
        ),
      ).toEqual({ ...reservation, state: "finalized" });
      expect(
        await target`SELECT context_source_id, work_id, final_path, canonical_uri, object_key, fingerprint FROM upload_intakes`,
      ).toEqual([
        {
          context_source_id: id(8),
          work_id: id(4),
          final_path: "Scratch (2)/map.png",
          canonical_uri: "unfiled://Scratch (2)/map.png",
          object_key: `uploads/${id(2)}/${id(21)}`,
          fingerprint: "retained-fingerprint",
        },
      ]);
      // Load the actual catalog adapter at runtime: package typechecks must not
      // pull Nitro's composition-only virtual assets into the database package.
      const { createDrizzleContextCatalog } = (await import(
        new URL(
          "../../../apps/server/server/domains/context/adapters/context-catalog.ts",
          import.meta.url,
        ).href
      )) as { createDrizzleContextCatalog(db: Database): ContextCatalog };
      const catalog = createDrizzleContextCatalog(db);
      const snapshot = await catalog.snapshot({ kind: "project", projectId: id(2) as never });
      expect(snapshot.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entryId: id(14),
            uri: "unfiled://Scratch (2)/nested/deep/jade-map.md",
          }),
          expect.objectContaining({ entryId: id(15), uri: "unfiled://Scratch (2)/root-note.md" }),
        ]),
      );
      expect(snapshot.entries.some((entry) => entry.entryId === id(16))).toBe(false);
      expect(
        (
          await catalog.snapshot({
            kind: "work",
            projectId: id(2) as never,
            workId: id(4) as never,
          })
        ).entries,
      ).toEqual([]);
      const online = (
        await readFile(path.join(migrations, "0034_context_source_online_indexes.sql"), "utf8")
      ).split("--> statement-breakpoint");
      await cp(
        path.join(migrations, "0034_context_source_online_indexes.sql"),
        path.join(directory, "0034_context_source_online_indexes.sql"),
      );
      await writeFile(path.join(directory, "meta/_journal.json"), JSON.stringify(journal));
      // A failed concurrent build leaves an invalid remnant. The real runner
      // removes that remnant without touching the still-valid old guard.
      await expect(
        target.unsafe(
          "CREATE UNIQUE INDEX CONCURRENTLY context_sources_project_scope_slug ON context_sources(slug)",
        ),
      ).rejects.toMatchObject({ code: "23505" });
      expect(
        await target`SELECT indisvalid FROM pg_index WHERE indexrelid = 'context_sources_project_scope_slug'::regclass`,
      ).toEqual([{ indisvalid: false }]);
      await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
      const writer = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
      try {
        // Each cut starts from a fresh old-index state, not the result
        // of the previous retry. Probe duplicates from another backend.
        for (let cut = 0; cut <= online.length; cut++) {
          await target.unsafe(
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS context_sources_project_slug ON context_sources(project_id, slug) WHERE work_id IS NULL AND deleted_at IS NULL",
          );
          await target.unsafe(
            "DROP INDEX CONCURRENTLY IF EXISTS context_sources_project_scope_slug",
          );
          await target.unsafe("DROP INDEX CONCURRENTLY IF EXISTS context_sources_lineage_slug");
          await target`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${journal.entries[34].when}`;
          for (const statement of online.slice(0, cut))
            if (statement.trim()) await target.unsafe(statement);
          expect(
            await writer`INSERT INTO context_sources(project_id, name, slug, scope) VALUES (${id(2)}, 'Duplicate', 'unfiled', 'project') ON CONFLICT DO NOTHING RETURNING id`,
          ).toEqual([]);
          await runMigrations({ databaseUrl: databaseUrl ?? "", migrationsDirectory: directory });
          expect(
            await writer`INSERT INTO context_sources(project_id, name, slug, scope) VALUES (${id(2)}, 'Duplicate', 'unfiled', 'project') ON CONFLICT DO NOTHING RETURNING id`,
          ).toEqual([]);
        }
      } finally {
        await writer.end();
      }
      expect(
        await target`SELECT count(*)::integer AS count FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('context_sources_project_scope_slug', 'context_sources_lineage_slug') AND i.indisvalid`,
      ).toEqual([{ count: 2 }]);
      expect(
        await target`SELECT conname FROM pg_constraint WHERE conrelid = 'context_sources'::regclass AND NOT convalidated`,
      ).toEqual([]);
    } finally {
      await db.close();
      if (isolated)
        await target.begin(async (tx) => {
          await tx`ALTER EXTENSION pg_trgm SET SCHEMA scratch_archive_saved_public`;
          await tx`DROP SCHEMA IF EXISTS public CASCADE`;
          await tx`DROP SCHEMA IF EXISTS drizzle CASCADE`;
          await tx`ALTER SCHEMA scratch_archive_saved_public RENAME TO public`;
          await tx`ALTER SCHEMA scratch_archive_saved_drizzle RENAME TO drizzle`;
        });
      await target.end();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
