/**
 * Migration 0130 ranks every visible child in the order the old name-ordered parents displayed,
 * so nothing moves when the order policy goes, and rotates every catalog generation.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - rank order equals `compareDefaultSiblings` for a name-ordered parent, and a manual parent's
 *   unranked children go before its first ranked child (kb/decisions/documents/lifecycle/sibling-order-is-placement.md)
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareDefaultSiblings } from "@meridian/resource-replica";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../../../../../tools/dev/lib/migration-runner";
import { disposableTestDatabaseTarget } from "../../../../../../tools/dev/lib/test-db-lifecycle";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("ordered-folders migration (postgres)", () => {});
} else {
  describe("ordered-folders migration (postgres)", () => {
    it("ranks name-ordered parents as the client displayed them and keeps manual ranks", async () => {
      const migrations = fileURLToPath(
        new URL("../../../../../../packages/database/src/migrations/", import.meta.url),
      );
      const journal = JSON.parse(
        await readFile(path.join(migrations, "meta/_journal.json"), "utf8"),
      );
      const index = journal.entries.findIndex(
        (entry: { tag: string }) => entry.tag === "0130_ordered_folders",
      );
      expect(index).toBeGreaterThan(0);
      const target = disposableTestDatabaseTarget(databaseUrl, `ordered_folders_${process.pid}`);
      const adminUrl = new URL(databaseUrl);
      adminUrl.pathname = "/postgres";
      const admin = postgres(adminUrl.toString(), { max: 1 });
      const db = postgres(target.databaseUrl, { max: 1 });
      const root = await mkdtemp(path.join(tmpdir(), "meridian-ordered-folders-"));
      const before = path.join(root, "migrations");
      try {
        await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
        await mkdir(path.join(before, "meta"), { recursive: true });
        const applied = new Set(
          journal.entries.slice(0, index).map((entry: { tag: string }) => `${entry.tag}.sql`),
        );
        for (const file of await readdir(migrations))
          if ((file.endsWith(".sql") && applied.has(file)) || file.endsWith(".ts"))
            await symlink(path.join(migrations, file), path.join(before, file));
        await writeFile(
          path.join(before, "meta/_journal.json"),
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) }),
        );
        await runMigrations({ databaseUrl: target.databaseUrl, migrationsDirectory: before });

        const userId = randomUUID();
        const projectId = randomUUID();
        await db`INSERT INTO users (id, external_id, email) VALUES (${userId}, 'u', 'u@test.invalid')`;
        await db`INSERT INTO projects (id, user_id, name, slug) VALUES (${projectId}, ${userId}, 'P', 'p')`;
        const source = async (slug: string, policy: string) => {
          const [row] = await db<{ id: string }[]>`INSERT INTO context_sources
            (project_id, slug, name, scope, order_policy)
            VALUES (${projectId}, ${slug}, ${slug}, 'project', ${policy}) RETURNING id`;
          return row?.id as string;
        };
        const folder = async (
          sourceId: string,
          parentId: string | null,
          name: string,
          opts: { policy?: string; rank?: string | null; hidden?: boolean; deleted?: boolean } = {},
        ) => {
          const [row] = await db<{ id: string }[]>`INSERT INTO folders
            (context_source_id, parent_id, name, order_policy, rank, hidden, deleted_at)
            VALUES (${sourceId}, ${parentId}, ${name}, ${opts.policy ?? "default"}, ${opts.rank ?? null},
              ${opts.hidden ?? false}, ${opts.deleted ? new Date() : null}) RETURNING id`;
          return row?.id as string;
        };
        const file = async (
          sourceId: string,
          parentId: string | null,
          name: string,
          extension: string,
          opts: { rank?: string | null; hidden?: boolean } = {},
        ) => {
          const [row] = await db<{ id: string }[]>`INSERT INTO documents
            (context_source_id, folder_id, name, extension, file_type, rank, hidden)
            VALUES (${sourceId}, ${parentId}, ${name}, ${extension}, 'markdown', ${opts.rank ?? null},
              ${opts.hidden ?? false}) RETURNING id`;
          return row?.id as string;
        };

        const named = await source("manuscript", "default");
        const manual = await source("kb", "manual");
        const names = [
          "Chapter 10",
          "Chapter 2",
          "chapter 2",
          "Édith",
          "Arc 1 · Cold",
          "Zed",
          "alpha",
        ];
        for (const name of names) await file(named, null, name, "md");
        await file(named, null, "notes", "json");
        await file(named, null, "Hidden", "md", { hidden: true });
        for (const name of ["Arc 3 · Court", "Arc 2 · Ash", "arc 2 · ash"])
          await folder(named, null, name);
        await folder(named, null, "Deleted", { deleted: true });
        const inner = await folder(named, null, "Inner");
        await file(named, inner, "b", "md");
        await file(named, inner, "a", "md");

        // A manual parent: ranks stay, and its unranked children go before the first ranked one.
        const second = await file(manual, null, "second", "md", { rank: "a1" });
        const first = await file(manual, null, "first", "md", { rank: "a0" });
        const lateNull = await file(manual, null, "null-b", "md");
        const earlyNull = await folder(manual, null, "null-a");

        const heads = () =>
          db<{ generation: string }[]>`SELECT generation FROM context_catalog_scope_heads`;
        await db`INSERT INTO context_catalog_scope_heads (scope_key, scope) VALUES ('project:t', '{}')`;
        const generationBefore = await heads();
        await runMigrations({ databaseUrl: target.databaseUrl, migrationsDirectory: migrations });
        // A stored client catalog carries no ranks; a new generation forces it to refetch.
        expect(await heads()).not.toEqual(generationBefore);

        const rows = await db<
          {
            id: string;
            kind: "folder" | "file";
            name: string;
            rank: string | null;
            src: string;
            parent: string | null;
          }[]
        >`SELECT id, 'folder' AS kind, name, rank, context_source_id AS src, parent_id AS parent
            FROM folders WHERE deleted_at IS NULL AND NOT hidden
          UNION ALL SELECT id, 'file', CASE WHEN extension = '' THEN name ELSE name || '.' || extension END,
            rank, context_source_id, folder_id FROM documents WHERE deleted_at IS NULL AND NOT hidden`;
        expect(rows.every((row) => row.rank !== null)).toBe(true);
        const byRank = (sourceId: string, parent: string | null) =>
          rows
            .filter((row) => row.src === sourceId && row.parent === parent)
            .sort((a, b) => ((a.rank as string) < (b.rank as string) ? -1 : 1))
            .map((row) => row.id);
        for (const [sourceId, parent] of [
          [named, null],
          [named, inner],
        ] as const) {
          const expected = rows
            .filter((row) => row.src === sourceId && row.parent === parent)
            .sort((a, b) =>
              compareDefaultSiblings(
                { kind: a.kind, name: a.name, identity: a.id },
                { kind: b.kind, name: b.name, identity: b.id },
              ),
            )
            .map((row) => row.id);
          expect(byRank(sourceId, parent)).toEqual(expected);
        }
        expect(byRank(manual, null)).toEqual([...[earlyNull, lateNull].sort(), first, second]);
        expect(rows.find((row) => row.id === first)?.rank).toBe("a0");
        expect(rows.find((row) => row.id === second)?.rank).toBe("a1");
        const hidden = await db`SELECT rank FROM documents WHERE hidden`;
        expect(hidden).toEqual([{ rank: null }]);
      } finally {
        await db.end();
        await admin.end();
        const cleanup = postgres(adminUrl.toString(), { max: 1 });
        try {
          await cleanup.unsafe(`DROP DATABASE IF EXISTS "${target.databaseName}" WITH (FORCE)`);
        } finally {
          await cleanup.end();
        }
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
