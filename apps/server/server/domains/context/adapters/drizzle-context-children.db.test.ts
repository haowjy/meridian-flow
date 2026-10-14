/** PostgreSQL proof for sibling-batch atomicity, seeded placeholder identities and linear catalog refresh count. */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsCheckpoints,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrizzleCollabPersistence } from "../../collab/adapters/drizzle-journal.js";
import { createInMemoryCoordinator } from "../../collab/adapters/in-memory/agent-edit.js";
import { createStaticDocumentLinkScopes } from "../../collab/adapters/in-memory/static-document-link-scopes.js";
import { createAgentEditRuntime } from "../../collab/domain/agent-edit-runtime.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { createDrizzleContextChildCreation } from "./drizzle-context-children.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("context child creation (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 4 });
  let projectId: string, sourceId: string;
  let refreshes: number;
  let subject: ReturnType<typeof setup>;
  function setup() {
    refreshes = 0;
    const persistence = createDrizzleCollabPersistence(db);
    const coordinator = createInMemoryCoordinator(persistence.journal);
    const runtime = createAgentEditRuntime({
      journal: persistence.journal,
      landingJournal: persistence.journal,
      coordinator,
      lifecycle: persistence.lifecycle,
      initialDocumentSeeds: persistence.lifecycle,
      // This fixture needs durable seeds, not rooms or publication. The journal is the assertion boundary.
      deferUntilCommit: () => true,
      runDocumentWriteHook: async () => {},
      resolveDocumentFiletype: async () => "markdown",
      observability: {},
      links: createStaticDocumentLinkScopes(),
      aheadRefs: { register: async () => {} },
      inTransaction: () => false,
    });
    const catalog = createDrizzleContextCatalog(db);
    const children = createDrizzleContextChildCreation({
      db,
      documents: {
        bindStatic: runtime.linkBinder.bindStatic,
        seedFromMarkdown: runtime.markdownDocuments.seedFromMarkdown,
      },
      // KB never consults manifest membership; this fixture has no Manuscript source.
      recordMembership: async () => {},
      arrivals: { lockNamespaces: async () => {}, settle: async () => 0 },
      catalog: {
        refreshSources: async (ids) => {
          refreshes++;
          return catalog.refreshSources(ids);
        },
      },
    });
    return { children, catalog };
  }
  const placeholder = (id = randomUUID(), name = "note") => ({
    id,
    name,
    extension: "",
    filetype: "markdown" as const,
    metadata: { importPending: true },
  });
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    const user = randomUUID();
    projectId = randomUUID();
    sourceId = randomUUID();
    await db.insert(users).values(conformanceUserValues(user, "bulk-creation"));
    await db.insert(projects).values({ id: projectId, userId: user, name: "Bulk", slug: "bulk" });
    await db.insert(contextSources).values({ id: sourceId, projectId, name: "KB", slug: "kb" });
    subject = setup();
  });
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });

  const root = () => ({ sourceId, folderId: null });

  // Operation count, not time: one catalog refresh per chunk, whatever its size.
  // Scale timings live in apps/server/scripts/probe-import-performance.ts.
  it("creates each chunk's placeholders with exactly one real catalog refresh", async () => {
    const folderId = randomUUID();
    const chunks = 3,
      size = 4;
    const ids = Array.from({ length: chunks * size }, () => randomUUID());
    await subject.children.createChildren({
      parent: root(),
      folders: [{ id: folderId, name: "Notes" }],
      documents: [],
    });
    refreshes = 0;
    for (let chunk = 0; chunk < chunks; chunk++) {
      await subject.children.createChildren({
        parent: { sourceId, folderId },
        folders: [],
        documents: ids
          .slice(chunk * size, (chunk + 1) * size)
          .map((id, index) => placeholder(id, `note-${chunk * size + index}`)),
      });
    }
    expect(refreshes).toBe(chunks);
    expect(await db.select().from(documents)).toHaveLength(ids.length);
    expect(await db.select().from(documentYjsCheckpoints)).toHaveLength(ids.length);
    const snapshot = await subject.catalog.snapshot({
      kind: "project",
      projectId: projectId as never,
    });
    const files = snapshot.entries.filter((entry) => entry.kind === "file");
    expect(files.map(({ entryId }) => entryId).sort()).toEqual([...ids].sort());
    expect(files.every((entry) => entry.importPending)).toBe(true);
  });

  it("rolls all identities, seeds and catalog rows back with its caller", async () => {
    await expect(
      runInDrizzleTransaction(db, async () => {
        await subject.children.createChildren({
          parent: root(),
          folders: [{ id: randomUUID(), name: "Notes" }],
          documents: [placeholder(undefined, "one")],
        });
        expect(await currentDrizzleDb(db).select().from(documents)).toHaveLength(1);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.select().from(documents)).toEqual([]);
    expect(await db.select().from(folders)).toEqual([]);
    expect(await db.select().from(documentYjsCheckpoints)).toEqual([]);
    expect(
      (
        await subject.catalog.snapshot({ kind: "project", projectId: projectId as never })
      ).entries.filter(({ kind }) => kind === "file"),
    ).toEqual([]);
  });

  it("a taken name or opposite-kind claim refuses the whole chunk without merging", async () => {
    const kept = placeholder(undefined, "kept");
    await subject.children.createChildren({ parent: root(), folders: [], documents: [kept] });
    await expect(
      subject.children.createChildren({
        parent: root(),
        folders: [{ id: randomUUID(), name: "new-folder" }],
        documents: [placeholder(undefined, "kept")],
      }),
    ).rejects.toThrow();
    expect(await db.select().from(folders)).toEqual([]);
    expect((await db.select().from(documents)).map(({ id }) => id)).toEqual([kept.id]);
    await expect(
      subject.children.createChildren({
        parent: root(),
        folders: [{ id: randomUUID(), name: "taken.md" }],
        documents: [placeholder(undefined, "taken")],
      }),
    ).rejects.toThrow("already exists");
    expect(await db.select().from(folders)).toEqual([]);
    expect(refreshes).toBe(1);
  });

  it("rejects a parent that is not live in the source without creating rows", async () => {
    await expect(
      subject.children.createChildren({
        parent: { sourceId, folderId: randomUUID() },
        folders: [],
        documents: [placeholder(undefined, "one")],
      }),
    ).rejects.toThrow("parent");
    expect(await db.select().from(documents)).toEqual([]);
    expect(refreshes).toBe(0);
  });
});
