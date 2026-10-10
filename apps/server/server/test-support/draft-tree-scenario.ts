/**
 * One scenario builder for the draft-tree DB tests (contract §16.1): a project with its
 * sources, Works with their primary threads, and seed verbs that write tree rows the way
 * the product's creates leave them, without going through commands. Command verbs join
 * as the lanes that build those commands land.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources.
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
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  draftTreeChanges,
  folders,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../domains/collab/adapters/drizzle-drafts.js";
import { createDrafts, type Drafts } from "../domains/collab/domain/drafts.js";
import type { Draft } from "../domains/collab/domain/ports/draft-store.js";

export type ScenarioSource = "manuscript" | "kb" | "unfiled";

export type ScenarioWork = {
  id: WorkId;
  slug: string;
  threadId: ThreadId;
  mode: "draft" | "direct";
};

export interface DraftTreeScenario {
  project: { id: ProjectId; userId: UserId; sources: Record<ScenarioSource, ContextSourceId> };
  /** The production drafts resolver over this scenario's database. */
  drafts: Drafts;
  /** A Work and its primary thread. */
  work(name: string, mode: "draft" | "direct"): Promise<ScenarioWork>;
  /** A live document, with live folders made as needed. */
  seedLive(path: string): Promise<DocumentId>;
  /** A live folder chain; returns the leaf. */
  seedLiveFolder(path: string): Promise<FolderId>;
  /**
   * A document the Work's draft created: hidden folders made (or joined) as needed, a
   * hidden document at the path, and the draft's `created` row at that location. Makes
   * the Work's draft if it has none. Always a new document; joining is a command's job.
   */
  seedHidden(work: ScenarioWork, path: string): Promise<DocumentId>;
  /** The Work's active draft, made at the write boundary if absent. */
  draftOf(work: ScenarioWork): Promise<Draft>;
}

const SOURCES: readonly ScenarioSource[] = ["manuscript", "kb", "unfiled"];

export async function draftTreeScenario(db: Database): Promise<DraftTreeScenario> {
  const userId = randomUUID() as UserId;
  const projectId = randomUUID() as ProjectId;
  // One user per scenario, so a case may build several.
  await db
    .insert(users)
    .values(conformanceUserValues(userId, `draft-tree-scenario-${userId.slice(0, 8)}`));
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
  const sources = Object.fromEntries(
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
  ) as Record<ScenarioSource, ContextSourceId>;
  const drafts = createDrafts({
    store: createDrizzleDraftStore(db),
    boundary: createDrizzleDraftWriteBoundary(db),
  });

  function locate(path: string) {
    const match = /^(kb|unfiled|manuscript):\/\/(.*)$/.exec(path);
    const source = (match?.[1] ?? "manuscript") as ScenarioSource;
    const segments = (match?.[2] ?? path).split("/").filter(Boolean);
    const filename = segments.pop();
    if (!filename) throw new Error(`Scenario path names no file: ${path}`);
    return { sourceId: sources[source], dir: segments, filename };
  }

  function splitFilename(filename: string) {
    const dot = filename.lastIndexOf(".");
    return dot <= 0
      ? { name: filename, extension: "" }
      : { name: filename.slice(0, dot), extension: filename.slice(dot + 1) };
  }

  /** Folders root to leaf: a matching folder with this hiddenness is reused, else made. */
  async function folderChain(
    sourceId: ContextSourceId,
    dir: readonly string[],
    hidden: boolean,
  ): Promise<FolderId | null> {
    let parentId: FolderId | null = null;
    for (const name of dir) {
      const [existing] = await db
        .select({ id: folders.id, hidden: folders.hidden })
        .from(folders)
        .where(
          and(
            eq(folders.contextSourceId, sourceId),
            parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
            eq(folders.name, name),
            isNull(folders.deletedAt),
          ),
        );
      // A live folder serves a hidden create too (a draft places under what it sees).
      if (existing && (!existing.hidden || hidden)) {
        parentId = existing.id;
        continue;
      }
      const [created]: { id: FolderId }[] = await db
        .insert(folders)
        .values({ contextSourceId: sourceId, parentId, name, hidden })
        .returning({ id: folders.id });
      if (!created) throw new Error(`Folder ${name} was not inserted`);
      parentId = created.id;
    }
    return parentId;
  }

  async function insertDocument(
    sourceId: ContextSourceId,
    folderId: FolderId | null,
    filename: string,
    hidden: boolean,
  ): Promise<DocumentId> {
    const [row] = await db
      .insert(documents)
      .values({ contextSourceId: sourceId, folderId, ...splitFilename(filename), hidden })
      .returning({ id: documents.id });
    if (!row) throw new Error(`Document ${filename} was not inserted`);
    return row.id;
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
    project: { id: projectId, userId, sources },
    drafts,
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
      const threadId = randomUUID() as ThreadId;
      await db.insert(threads).values({
        id: threadId,
        projectId,
        createdByUserId: userId,
        rootThreadId: threadId,
        title: name,
      });
      await db.insert(threadWorks).values({ threadId, workId: work.id, projectId });
      return { id: work.id, slug, threadId, mode };
    },
    async seedLive(path) {
      const { sourceId, dir, filename } = locate(path);
      return insertDocument(sourceId, await folderChain(sourceId, dir, false), filename, false);
    },
    async seedLiveFolder(path) {
      const { sourceId, dir, filename } = locate(path);
      const leaf = await folderChain(sourceId, [...dir, filename], false);
      if (!leaf) throw new Error(`Scenario path names no folder: ${path}`);
      return leaf;
    },
    draftOf,
    async seedHidden(work, path) {
      const draft = await draftOf(work);
      const { sourceId, dir, filename } = locate(path);
      const folderId = await folderChain(sourceId, dir, true);
      const documentId = await insertDocument(sourceId, folderId, filename, true);
      const { name, extension } = splitFilename(filename);
      await db.insert(draftTreeChanges).values({
        draftId: draft.id,
        nodeKind: "document",
        nodeId: documentId,
        created: true,
        contextSourceId: sourceId,
        parentFolderId: folderId,
        name,
        extension,
      });
      return documentId;
    },
  };
}
