/**
 * The draft-tree DB tests' world and seed verbs (contract §16.1): a project with its
 * sources, Works with their primary threads, rows written the way the product's creates
 * leave them, and the link resolve route's answer over this database. No composed
 * runtime: command verbs live in `draft-tree-commands.ts`.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources.
 */
import { randomUUID } from "node:crypto";
import type {
  ContextSourceId,
  DocumentId,
  DocumentLinkAnswer,
  FolderId,
  ProjectId,
  ResolveDocumentLinksResponse,
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
  linkAheadDraftSettlements,
  linkAheadHolderBindings,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  turns,
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
import { createLinkScopeObserver } from "../domains/collab/index.js";
import { createDrizzleContextCatalog } from "../domains/context/adapters/context-catalog.js";
import { createDrizzleDocumentLinkHistory } from "../domains/context/adapters/document-link-history.js";
import { createDrizzleDocumentLinkScopes } from "../domains/context/adapters/document-link-scope.js";
import { createDocumentLinkResolver } from "../domains/context/document-link-resolution.js";
import { createDrizzleFileFacts } from "../domains/file-policy/adapters/drizzle-file-facts.js";
import { createOwnerFileGrants } from "../domains/file-policy/adapters/owner-file-grants.js";
import { createFileAccess } from "../domains/file-policy/file-access.js";
import {
  createDrizzleProjectRepository,
  createDrizzleProjectWorkAuthorityResolver,
} from "../domains/projects/index.js";
import { handleDocumentLinkResolveRequest } from "../lib/document-link-route.js";

export type ScenarioSource = "manuscript" | "kb" | "unfiled";

export type ScenarioWork = {
  id: WorkId;
  slug: string;
  threadId: ThreadId;
  turnId: string;
  mode: "draft" | "direct";
};

export interface DraftTreeWorld {
  project: { id: ProjectId; userId: UserId; sources: Record<ScenarioSource, ContextSourceId> };
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
  /** What the ahead ref means in the Work's draft. */
  seedDraftSettlement(work: ScenarioWork, aheadId: string, documentId: DocumentId): Promise<void>;
  /** What the ahead ref means in this holder (an Apply's binding). */
  seedHolderBinding(aheadId: string, holder: DocumentId, documentId: DocumentId): Promise<void>;
  /**
   * The resolve route's answer for one stored link, read in a Work's view or live, from
   * `baseUri` (null for chat) and, when given, the holder pinned by id.
   */
  linkAnswer(input: {
    view: ScenarioWork | "live";
    ref: string;
    href: string;
    baseUri: string | null;
    holderDocumentId?: DocumentId;
  }): Promise<{ answer: DocumentLinkAnswer; holderUri?: string }>;
}

const SOURCES: readonly ScenarioSource[] = ["manuscript", "kb", "unfiled"];

/** A source-qualified scenario path's scheme and source-relative path. */
export function sourceOf(path: string): { scheme: ScenarioSource; rel: string } {
  const match = /^(kb|unfiled|manuscript):\/\/(.*)$/.exec(path);
  return { scheme: (match?.[1] ?? "manuscript") as ScenarioSource, rel: match?.[2] ?? path };
}

function splitFilename(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot <= 0
    ? { name: filename, extension: "" }
    : { name: filename.slice(0, dot), extension: filename.slice(dot + 1) };
}

export async function draftTreeWorld(db: Database): Promise<DraftTreeWorld> {
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
  const madeWorks: WorkId[] = [];

  function locate(path: string) {
    const { scheme, rel } = sourceOf(path);
    const segments = rel.split("/").filter(Boolean);
    const filename = segments.pop();
    if (!filename) throw new Error(`Scenario path names no file: ${path}`);
    return { sourceId: sources[scheme], dir: segments, filename };
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

  async function linkAnswer(input: Parameters<DraftTreeWorld["linkAnswer"]>[0]) {
    const catalog = createDrizzleContextCatalog(db);
    const workAuthorityResolver = createDrizzleProjectWorkAuthorityResolver(db);
    // The product's file policy: the project owner reads its own documents, no one else's.
    const fileAccess = createFileAccess({
      facts: createDrizzleFileFacts(db),
      grants: createOwnerFileGrants(),
      readAgentChain: async () => [],
    });
    const response: ResolveDocumentLinksResponse = await handleDocumentLinkResolveRequest(
      {
        projectRepo: createDrizzleProjectRepository({
          db,
          catalogLifecycle: catalog,
          ensureNoWork: async () => {
            throw new Error("The scenario's project already has its No Work row");
          },
        }),
        documentLinks: createDocumentLinkResolver({
          catalog,
          workAuthorityResolver,
          history: createDrizzleDocumentLinkHistory(db),
        }),
        linkScopes: createDrizzleDocumentLinkScopes({
          db,
          fileAccess,
          observer: createLinkScopeObserver(),
        }),
        workAuthorityResolver,
        fileAccess,
        drafts,
      },
      {
        projectId,
        userId,
        request: {
          workId: input.view === "live" ? null : input.view.id,
          baseUri: input.baseUri,
          ...(input.holderDocumentId ? { holderDocumentId: input.holderDocumentId } : {}),
          links: [{ ref: input.ref, href: input.href }],
        },
      },
    );
    const [answer] = response.answers;
    if (!answer) throw new Error("The resolve route answered nothing");
    return {
      answer,
      ...(response.holderUri !== undefined ? { holderUri: response.holderUri } : {}),
    };
  }

  return {
    project: { id: projectId, userId, sources },
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
      return insertDocument(sourceId, await folderChain(sourceId, dir, false), filename, false);
    },
    async seedLiveFolder(path) {
      const { sourceId, dir, filename } = locate(path);
      const leaf = await folderChain(sourceId, [...dir, filename], false);
      if (!leaf) throw new Error(`Scenario path names no folder: ${path}`);
      return leaf;
    },
    async seedHidden(work, path, hiddenOptions = {}) {
      const draft = await draftOf(work);
      const { sourceId, dir, filename } = locate(path);
      const folderId = await folderChain(sourceId, dir, true);
      const documentId =
        hiddenOptions.join ?? (await insertDocument(sourceId, folderId, filename, true));
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
    async seedDraftSettlement(work, aheadId, documentId) {
      const draft = await draftOf(work);
      await db.insert(linkAheadDraftSettlements).values({ aheadId, draftId: draft.id, documentId });
    },
    async seedHolderBinding(aheadId, holder, documentId) {
      await db
        .insert(linkAheadHolderBindings)
        .values({ aheadId, holderDocumentId: holder, documentId });
    },
    linkAnswer,
  };
}
