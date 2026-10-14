/**
 * The draft-tree DB tests' world and seed verbs (contract §16.1): a project with its
 * sources, Works with their primary threads, rows written the way the product's creates
 * leave them, written through the tree's own row writers. No composed runtime: command
 * verbs, the link resolve route's answer among them, live in `draft-tree-commands.ts`.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources, or `user://` for the account's personal source (in its
 * personal project, shared by every world of the account).
 */

import { randomUUID } from "node:crypto";
import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../domains/collab/adapters/drizzle-drafts.js";
import { createDrafts, type Drafts } from "../domains/collab/domain/drafts.js";
import type { Draft } from "../domains/collab/domain/ports/draft-store.js";
import { lockContextSources } from "../domains/context/adapters/context-fs/document-locations.js";
import { recordCreated } from "../domains/context/tree/draft-tree-store.js";
import { insertDocumentRow, insertFolder } from "../domains/context/tree/node-rows.js";
import { ensureLiveFolderPath, walkFolders } from "../domains/context/tree/placement.js";
import { runInDrizzleTransaction } from "../shared/drizzle-transaction.js";

export type ScenarioSource = "manuscript" | "kb" | "unfiled" | "user";

export type ScenarioWork = {
  id: WorkId;
  slug: string;
  threadId: ThreadId;
  turnId: string;
  mode: "draft" | "direct";
};

export interface DraftTreeWorld {
  /** The database the world lives in. */
  db: Database;
  project: {
    id: ProjectId;
    userId: UserId;
    /** The account's personal project, where `user://` lives. */
    personalId: ProjectId;
    sources: Record<ScenarioSource, ContextSourceId>;
  };
  /** The production drafts resolver over this scenario's database. */
  drafts: Drafts;
  /** Every Work this world made, in order. */
  works(): readonly WorkId[];
  /** A Work and its primary thread. */
  work(name: string, mode: "draft" | "direct"): Promise<ScenarioWork>;
  /** Another thread whose primary Work is `work`. */
  thread(work: ScenarioWork): Promise<ScenarioWork>;
  /** The Work's active draft, made at the write boundary if absent. */
  draftOf(work: ScenarioWork): Promise<Draft>;
  /** A live document, with live folders made as needed. */
  seedLive(path: string): Promise<DocumentId>;
  /** A live folder chain; returns the leaf. */
  seedLiveFolder(path: string): Promise<FolderId>;
  /**
   * A document the Work's draft created: hidden folders made (or joined) as needed, a
   * hidden document at the path, and the draft's `created` row at that location. Makes
   * the Work's draft if it has none. A new document, unless `join` names a hidden one this
   * draft then uses at `path` too (the row a create's join leaves, at a location of its own).
   */
  seedHidden(
    work: ScenarioWork,
    path: string,
    options?: { join?: DocumentId },
  ): Promise<DocumentId>;
  /** A registry row for an ahead ref at `path`, settled live to `settledTo` if given. */
  seedAhead(path: string, options?: { settledTo?: DocumentId }): Promise<string>;
}

const SOURCES = ["manuscript", "kb", "unfiled"] as const;

/** A source-qualified scenario path's scheme and source-relative path. */
export function sourceOf(path: string): { scheme: ScenarioSource; rel: string } {
  const match = /^(kb|unfiled|manuscript|user):\/\/(.*)$/.exec(path);
  return { scheme: (match?.[1] ?? "manuscript") as ScenarioSource, rel: match?.[2] ?? path };
}

/** A seeded row's stored parts: the name codec's canonical name, as every create stores it. */
function splitFilename(filename: string) {
  const parsed = parseDocumentFilename(filename);
  if (!parsed.ok) throw new Error(`Seed name ${filename}: ${parsed.error.message}`);
  return { name: parsed.value.name, extension: parsed.value.extension };
}

/** The account's personal project and its `user://` source, made once per account. */
export async function personalUserSource(db: Database, userId: UserId) {
  const [existing] = await db
    .select({ projectId: projects.id, sourceId: contextSources.id })
    .from(projects)
    .innerJoin(
      contextSources,
      and(eq(contextSources.projectId, projects.id), eq(contextSources.slug, "user")),
    )
    .where(and(eq(projects.userId, userId), eq(projects.isPersonal, true)))
    .limit(1);
  if (existing) return existing;
  const personalId = randomUUID() as ProjectId;
  await db.insert(projects).values({
    id: personalId,
    userId,
    name: "User Files",
    slug: `user-files-${personalId.slice(0, 8)}`,
    isPersonal: true,
  });
  const [source] = await db
    .insert(contextSources)
    .values({ projectId: personalId, name: "User Files", slug: "user" })
    .returning({ id: contextSources.id });
  if (!source) throw new Error("The user source was not inserted");
  return { projectId: personalId, sourceId: source.id };
}

/** A world in a new account, or another project of `options.account`'s. */
export async function draftTreeWorld(
  db: Database,
  options: { account?: UserId } = {},
): Promise<DraftTreeWorld> {
  const userId = options.account ?? (randomUUID() as UserId);
  const projectId = randomUUID() as ProjectId;
  // One user per scenario unless shared, so a case may build several.
  if (!options.account) {
    await db
      .insert(users)
      .values(conformanceUserValues(userId, `draft-tree-scenario-${userId.slice(0, 8)}`));
  }
  await db.insert(projects).values({
    id: projectId,
    userId,
    name: "Serial",
    slug: `serial-${projectId.slice(0, 8)}`,
  });
  await db.insert(works).values({
    projectId,
    createdByUserId: userId,
    name: "No Work",
    isNoWork: true,
  });
  const projectSources = Object.fromEntries(
    await Promise.all(
      SOURCES.map(async (slug, index) => {
        const [row] = await db
          .insert(contextSources)
          .values({
            projectId,
            name: slug,
            slug,
            isPrimary: slug === "manuscript",
            sortOrder: index,
          })
          .returning({ id: contextSources.id });
        if (!row) throw new Error(`Source ${slug} was not inserted`);
        return [slug, row.id] as const;
      }),
    ),
  ) as Record<(typeof SOURCES)[number], ContextSourceId>;
  const personal = await personalUserSource(db, userId);
  return draftTreeWorldOver(db, {
    id: projectId,
    userId,
    personalId: personal.projectId,
    sources: { ...projectSources, user: personal.sourceId },
  });
}

/**
 * A world over a project that already exists (a populated upgrade's, say): its sources
 * and the Works the scenario names, which `works()` lists before any it makes.
 */
export function draftTreeWorldOver(
  db: Database,
  project: DraftTreeWorld["project"],
  existingWorks: readonly WorkId[] = [],
): DraftTreeWorld {
  const { id: projectId, userId, sources } = project;
  const drafts = createDrafts({
    store: createDrizzleDraftStore(db),
    boundary: createDrizzleDraftWriteBoundary(db),
  });
  const madeWorks: WorkId[] = [...existingWorks];

  function locate(path: string) {
    const { scheme, rel } = sourceOf(path);
    const segments = rel.split("/").filter(Boolean);
    const filename = segments.pop();
    if (!filename) throw new Error(`Scenario path names no file: ${path}`);
    return { sourceId: sources[scheme], dir: segments, filename };
  }

  /** Live folders root to leaf, as `mkdir` makes them: a hidden one at the path is revealed. */
  function liveFolders(sourceId: ContextSourceId, dir: readonly string[]) {
    return runInDrizzleTransaction(db, async () => {
      await lockContextSources(db, [sourceId]);
      const ensured = await ensureLiveFolderPath(db, { contextSourceId: sourceId, dir });
      if (!ensured.ok) throw new Error(`Live folders ${dir.join("/")}: ${ensured.error.code}`);
      return ensured.value.folderId;
    });
  }

  /** The product's document insert: a live row claims its location, a hidden one doesn't. */
  async function insertDocument(
    sourceId: ContextSourceId,
    folderId: FolderId | null,
    filename: string,
    hidden: boolean,
  ): Promise<DocumentId> {
    const slot = { contextSourceId: sourceId, folderId, ...splitFilename(filename) };
    const id = await runInDrizzleTransaction(db, () =>
      insertDocumentRow(db, slot, { kind: "tracked", filetype: "markdown" }, { hidden }),
    );
    if (!id) throw new Error(`Document ${filename} was not inserted`);
    return id;
  }

  /** A thread with one assistant turn, primary in `workId`. */
  async function insertThread(title: string, workId: WorkId) {
    const threadId = randomUUID() as ThreadId;
    const turnId = randomUUID();
    await db.insert(threads).values({
      id: threadId,
      projectId,
      createdByUserId: userId,
      rootThreadId: threadId,
      title,
    });
    await db.insert(turns).values({
      id: turnId,
      threadId,
      position: 1,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await db.insert(threadWorks).values({ threadId, workId, projectId });
    return { threadId, turnId };
  }

  function draftOf(work: ScenarioWork): Promise<Draft> {
    return drafts.ensureActiveForWrite({
      workId: work.id,
      projectId,
      threadId: work.threadId,
      userId,
    });
  }

  return {
    db,
    project,
    drafts,
    works: () => madeWorks,
    async work(name, mode) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const [work] = await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name, slug, aiWriteMode: mode })
        .returning({ id: works.id });
      if (!work) throw new Error(`Work ${name} was not inserted`);
      const { threadId, turnId } = await insertThread(name, work.id);
      madeWorks.push(work.id);
      return { id: work.id, slug, threadId, turnId, mode };
    },
    async thread(work) {
      const { threadId, turnId } = await insertThread(`${work.slug} (second)`, work.id);
      return { ...work, threadId, turnId };
    },
    draftOf,
    async seedLive(path) {
      const { sourceId, dir, filename } = locate(path);
      return insertDocument(sourceId, await liveFolders(sourceId, dir), filename, false);
    },
    async seedLiveFolder(path) {
      const { sourceId, dir, filename } = locate(path);
      const leaf = await liveFolders(sourceId, [...dir, filename]);
      if (!leaf) throw new Error(`Scenario path names no folder: ${path}`);
      return leaf;
    },
    async seedHidden(work, path, hiddenOptions = {}) {
      const draft = await draftOf(work);
      const { sourceId, dir, filename } = locate(path);
      // A draft places under the folders it sees and makes hidden ones past the first gap.
      const walk = await walkFolders(
        db,
        { kind: "draft", draftId: draft.id },
        sourceId,
        dir,
        (gap) => insertFolder(db, { contextSourceId: sourceId, ...gap }, { hidden: true }),
      );
      if (walk.kind !== "walked") throw new Error(`Hidden folders ${dir.join("/")}: ${walk.kind}`);
      const documentId =
        hiddenOptions.join ?? (await insertDocument(sourceId, walk.folderId, filename, true));
      await recordCreated(db, {
        draftId: draft.id,
        documentId,
      });
      return documentId;
    },
    async seedAhead(path, aheadOptions = {}) {
      const { scheme, rel } = sourceOf(path);
      const aheadId = randomUUID();
      await db.insert(linkAheadRefs).values({
        aheadId,
        projectId,
        scheme,
        path: rel,
        ...(aheadOptions.settledTo
          ? { settledDocumentId: aheadOptions.settledTo, settledAt: new Date() }
          : {}),
      });
      return aheadId;
    },
  };
}
