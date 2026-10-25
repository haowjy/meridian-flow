/** Staged creation's placement, discard and Apply lock-order contracts against PostgreSQL. */
import { randomUUID } from "node:crypto";
import type { AheadMint } from "@meridian/agent-edit/integration";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  collabStagedStates,
  contextSources,
  contextStagedDocuments,
  contextStagedFolders,
  documentBranches,
  documentPreviousLocations,
  documents,
  folders,
  linkAheadRefs,
  projects,
  users,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrizzleCollabPersistence } from "../../collab/adapters/drizzle-journal.js";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import {
  createHarness,
  PROJECT_ID,
  resetDatabase,
  SOURCE_ID,
  USER_ID,
  WORK_ID,
} from "../../collab/test-support/change-trail-postgres-harness.js";
import type { ContextPlacement, ContextStage } from "../ports/context-staged-creation.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { createDrizzleDocumentArrivals } from "./document-arrivals.js";
import { createDrizzleContextStagedCreation } from "./drizzle-context-staging.js";
import { createDrizzleLinkAheadRegistry } from "./drizzle-link-ahead-registry.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("staged Context reveal (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
  const encoder = createInMemoryCollabDomain();
  const lifecycle = createDrizzleCollabPersistence(db).lifecycle;
  let projectId: string, userId: string, sourceId: string;
  let registry: ReturnType<typeof createDrizzleLinkAheadRegistry>;
  let subject: ReturnType<typeof createDrizzleContextStagedCreation>;
  const atomic = <T>(operation: () => Promise<T>) => runInDrizzleTransaction(db, operation);
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    userId = randomUUID();
    projectId = randomUUID();
    sourceId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "context-stage"));
    await db.insert(projects).values({ id: projectId, userId, name: "Staging", slug: "staging" });
    await db.insert(contextSources).values({ id: sourceId, projectId, name: "KB", slug: "kb" });
    registry = createDrizzleLinkAheadRegistry(db, async () => ({ members: [] }));
    subject = makeSubject();
  });
  afterAll(async () => {
    encoder.dispose();
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });
  function makeSubject(
    recordMembership: () => Promise<void> = async () => {},
    catalog = createDrizzleContextCatalog(db),
  ) {
    return createDrizzleContextStagedCreation({
      db,
      projectId,
      userId,
      ahead: registry,
      arrivals: createDrizzleDocumentArrivals(db, registry),
      catalog,
      recordMembership,
      documents: {
        ...lifecycle,
        async commitStagedStates(id) {
          await lifecycle.commitStagedStates(id);
        },
      },
    });
  }
  async function note(
    id: string,
    parentId: string | null,
    area: "kb" | "unfiled" | "manuscript",
    name: string,
    aheadMints: AheadMint[] = [],
  ): Promise<ContextStage["documents"][number]> {
    return {
      id,
      parentId,
      area,
      name,
      extension: "",
      filetype: "markdown",
      origin: { type: "system" },
      content: {
        kind: "tracked",
        aheadMints,
        seed: await encoder.prepareSeed({
          documentId: id as DocumentId,
          projectId,
          uri: `${area}://${name}`,
          content: encoder.bindStatic("Born complete: 界.\n"),
          origin: { type: "system" },
        }),
      },
    };
  }
  const mint = (address: string): AheadMint => ({
    ref: `ahead:${randomUUID()}` as AheadMint["ref"],
    holderProjectId: projectId as ProjectId,
    address,
  });
  const stagedCounts = async () =>
    Promise.all(
      [contextStagedFolders, contextStagedDocuments, collabStagedStates].map((table) =>
        db.select().from(table),
      ),
    );

  it("a taken top-level name changes nothing; a rebuilt two-area tree reveals complete rows and consumes old path aliases", async () => {
    const staging = randomUUID(),
      root = randomUUID(),
      child = randomUUID(),
      loose = randomUUID(),
      old = randomUUID();
    const existing = randomUUID();
    await db.insert(folders).values({ id: existing, contextSourceId: sourceId, name: "Existing" });
    const ahead = mint("kb://Existing/Book (2)/Unwritten");
    const nodes: ContextStage = {
      folders: [{ id: root, parentId: existing, area: "kb", name: "Book" }],
      documents: [
        await note(child, root, "kb", "Chapter", [ahead]),
        await note(loose, null, "unfiled", "Loose"),
      ],
    };
    const placement: ContextPlacement = {
      generation: 1,
      destinations: [
        { area: "kb", folderId: existing, uri: "kb://Existing/" },
        { area: "unfiled", folderId: null, uri: "unfiled://" },
      ],
      topLevelNames: new Map([
        [root, "Book"],
        [loose, "Loose"],
      ]),
    };
    await atomic(() => subject.stage(staging, 1, nodes));
    expect(await db.select().from(documents)).toEqual([]);
    expect(await db.select().from(linkAheadRefs)).toEqual([]);
    // R5: a prose document occupies a folder's normalized name too.
    await db.insert(documents).values({
      id: old,
      contextSourceId: sourceId,
      folderId: existing,
      name: "Book",
      fileType: "markdown",
    });
    expect(await atomic(() => subject.commitStaged(staging, placement))).toEqual({
      kind: "changed",
    });
    expect(await db.select().from(folders)).toEqual([expect.objectContaining({ id: existing })]);
    await db
      .insert(documentPreviousLocations)
      .values({ contextSourceId: sourceId, path: "Existing/Book (2)/Chapter", documentId: old });
    await atomic(async () => {
      await subject.discardStaged(staging);
      await subject.stage(staging, 2, {
        ...nodes,
        folders: [{ ...nodes.folders[0], name: "Book (2)" }],
      });
    });
    const committed = await atomic(() =>
      subject.commitStaged(staging, {
        ...placement,
        generation: 2,
        topLevelNames: new Map([
          [root, "Book (2)"],
          [loose, "Loose"],
        ]),
      }),
    );
    expect(committed.kind).toBe("committed");
    if (committed.kind === "committed") expect(committed.sourceIds).toHaveLength(2);
    expect((await db.select().from(documents)).filter((row) => row.id !== old)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: child,
          markdownProjection: "Born complete: 界.\n",
          sizeBytes: Buffer.byteLength("Born complete: 界.\n"),
        }),
        expect.objectContaining({ id: loose }),
      ]),
    );
    expect(await stagedCounts()).toEqual([[], [], []]);
    expect(await db.select().from(documentPreviousLocations)).toEqual([]);
    expect(await db.select().from(linkAheadRefs)).toEqual([
      expect.objectContaining({ aheadId: ahead.ref.slice(6), path: "Existing/Book (2)/Unwritten" }),
    ]);
  });

  it("stale generations never reveal; bounded discard and transactional reset leave neither seeds nor mints", async () => {
    const staging = randomUUID(),
      a = randomUUID(),
      b = randomUUID();
    const placement: ContextPlacement = {
      generation: 2,
      destinations: [{ area: "kb", folderId: null, uri: "kb://" }],
      topLevelNames: new Map([
        [a, "A"],
        [b, "B"],
      ]),
    };
    await atomic(() => subject.stage(staging, 1, { folders: [], documents: [] }));
    const discardedNotes = [
      await note(a, null, "kb", "A", [mint("kb://Unwritten")]),
      await note(b, null, "kb", "B"),
    ];
    await atomic(() => subject.stage(staging, 1, { folders: [], documents: discardedNotes }));
    expect(await atomic(() => subject.commitStaged(staging, placement))).toEqual({
      kind: "changed",
    });
    expect(await subject.discardStaged(staging, 1)).toEqual({ remaining: true });
    await expect(
      atomic(async () => {
        await subject.discardStaged(staging);
        throw new Error("rollback reset");
      }),
    ).rejects.toThrow("rollback reset");
    expect((await stagedCounts())[1]).toHaveLength(1);
    expect(await subject.discardStaged(staging)).toEqual({ remaining: false });
    expect(await stagedCounts()).toEqual([[], [], []]);
    expect(await db.select().from(documents)).toEqual([]);
    expect(await db.select().from(linkAheadRefs)).toEqual([]);
  });

  it("manifest Apply owns the namespace before activity; reveal waits without a project-row cycle and registers its qualified Scratch mint", async () => {
    await deleteDrizzleRows(db, [users]);
    await resetDatabase(db);
    projectId = PROJECT_ID;
    userId = USER_ID;
    sourceId = SOURCE_ID;
    const paused = deferred(),
      release = deferred();
    let manifestId: DocumentId | undefined,
      activityCalls = 0;
    let fixture: ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;
    registry = createDrizzleLinkAheadRegistry(db, (input) =>
      fixture.branchStore.resolveManifestMembership(input),
    );
    const harness = createHarness(db, {
      arrivals: createDrizzleDocumentArrivals(db, registry),
      async beforePushActivity(id) {
        if (id === manifestId) {
          activityCalls++;
          paused.resolve();
          await release.promise;
        }
      },
    });
    fixture = harness.crossWorkProbeFixture();
    try {
      const manifest = await fixture.branchStore.ensureProjectManifest({ projectId: PROJECT_ID });
      manifestId = manifest.documentId;
      manifest.doc.destroy();
      const draftOnly = randomUUID() as DocumentId;
      await db.insert(documents).values({
        id: draftOnly,
        contextSourceId: SOURCE_ID,
        name: "Draft only",
        fileType: "markdown",
      });
      await fixture.branchStore.recordManifestDocumentCreated(draftOnly, {
        projectId: PROJECT_ID,
        workId: WORK_ID,
      });
      const drafted = await fixture.branchStore.resolveManifestMembership({
        projectId: PROJECT_ID,
        workId: WORK_ID,
      });
      expect(drafted.members).toContain(draftOnly);
      const [branch] = await db
        .select()
        .from(documentBranches)
        .where(
          and(eq(documentBranches.documentId, manifestId), eq(documentBranches.workId, WORK_ID)),
        );
      if (!branch) throw new Error("Missing manifest draft");
      const ahead = mint("scratch://@atomicity-work/Unwritten"),
        imported = randomUUID(),
        staging = randomUUID();
      subject = makeSubject(
        () => fixture.branchStore.reconcileProjectManifest(PROJECT_ID),
        createDrizzleContextCatalog(db, undefined, {
          manifestMembership: {
            resolveManifestMembership: (input) =>
              fixture.branchStore.resolveManifestMembership(input),
          },
        }),
      );
      const importedNote = await note(imported, null, "manuscript", "Imported", [ahead]);
      await atomic(() => subject.stage(staging, 1, { folders: [], documents: [importedNote] }));
      const applying = fixture.realBranchPush.pushToLive({
        branchId: branch.id,
        pushedByUserId: USER_ID,
      });
      await paused.promise;
      const revealing = atomic(() =>
        subject.commitStaged(staging, {
          generation: 1,
          destinations: [{ area: "manuscript", folderId: null, uri: "manuscript://" }],
          topLevelNames: new Map([[imported, "Imported"]]),
        }),
      );
      // Wait for PostgreSQL itself to report the reveal queued behind Apply, not a timer guess.
      for (let i = 0; ; i++) {
        const [row] = await db.execute<{ waiting: boolean }>(
          sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())) as waiting`,
        );
        if (row.waiting) break;
        if (i === 200) throw new Error("Reveal did not wait on Apply");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      release.resolve();
      expect(await applying).toMatchObject({ status: "pushed" });
      expect(await revealing).toMatchObject({ kind: "committed" });
      expect(activityCalls).toBe(1);
      const live = await fixture.branchStore.resolveManifestMembership({ projectId: PROJECT_ID });
      expect(live.members).toEqual(expect.arrayContaining([draftOnly, imported]));
      expect(await db.select().from(linkAheadRefs)).toEqual([
        expect.objectContaining({
          aheadId: ahead.ref.slice(6),
          workId: WORK_ID,
          scheme: "scratch",
          path: "Unwritten",
        }),
      ]);
      expect(await stagedCounts()).toEqual([[], [], []]);
    } finally {
      release.resolve();
      harness.destroyWarmState();
    }
  }, 20_000);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
