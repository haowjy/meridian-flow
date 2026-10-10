/**
 * One scenario builder for the draft-tree DB tests (contract §16.1): a project with its
 * sources, Works with their primary threads, seed verbs that write tree rows the way the
 * product's creates leave them, and command verbs that drive the composed production
 * runtime (the real tool executor, route cores and ports) when one is given.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources, or `user://` for the writer's personal source (live verbs only).
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
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { ResolvedWorkAuthority, WorkSlug } from "@meridian/contracts/works";
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
import { and, eq, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../domains/collab/adapters/drizzle-drafts.js";
import { createDrafts, type Drafts } from "../domains/collab/domain/drafts.js";
import type { Draft } from "../domains/collab/domain/ports/draft-store.js";
import { createLinkScopeObserver } from "../domains/collab/index.js";
import { createDrizzleContextCatalog } from "../domains/context/adapters/context-catalog.js";
import { ContextFS } from "../domains/context/adapters/context-fs/context-fs.js";
import { createDrizzleDraftCreates } from "../domains/context/adapters/context-fs/drizzle-draft-creates.js";
import { DrizzleContextTreeMutationStore } from "../domains/context/adapters/context-fs/drizzle-tree-mutation-store.js";
import { createDrizzleDocumentLinkHistory } from "../domains/context/adapters/document-link-history.js";
import { createDrizzleDocumentLinkScopes } from "../domains/context/adapters/document-link-scope.js";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import { createProjectContextDocumentStore } from "../domains/context/context-source-provisioning.js";
import { createDocumentLinkResolver } from "../domains/context/document-link-resolution.js";
import type { ContextPort } from "../domains/context/ports/context-port.js";
import { setTreeHook, type TreeHookPoint } from "../domains/context/tree/test-hooks.js";
import { createDrizzleFileFacts } from "../domains/file-policy/adapters/drizzle-file-facts.js";
import { createOwnerFileGrants } from "../domains/file-policy/adapters/owner-file-grants.js";
import { createFileAccess } from "../domains/file-policy/file-access.js";
import {
  createDrizzleProjectRepository,
  createDrizzleProjectWorkAuthorityResolver,
} from "../domains/projects/index.js";
import type { ToolExecutionResult } from "../domains/runtime/tools/types.js";
import { handleDocumentLinkResolveRequest } from "../lib/document-link-route.js";
import {
  createContextEntry,
  parseCreateContextEntryBody,
} from "../routes/api/projects/[projectId]/context/[scheme]/create.post.js";
import type { useComposedRuntimes } from "./composed-runtime.js";

export type ScenarioSource = "manuscript" | "kb" | "unfiled";

export type ScenarioWork = {
  id: WorkId;
  slug: string;
  threadId: ThreadId;
  turnId: string;
  mode: "draft" | "direct";
};

type ComposedRuntimes = ReturnType<typeof useComposedRuntimes>;
export type ScenarioRuntime = Awaited<ReturnType<ComposedRuntimes["compose"]>>;

/** One model reply on a Work's thread: tool calls staged until `save` or `rollback`. */
export interface ScenarioReply {
  responseId: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
  save(): Promise<unknown>;
  rollback(): Promise<unknown>;
}

export interface ScenarioModel {
  reply(): Promise<ScenarioReply>;
  /** One reply that creates `path` with `text` and saves; the created document's id. */
  create(path: string, text: string): Promise<DocumentId>;
  /** One reply that copies `from` to `to` and saves. */
  copy(from: string, to: string): Promise<ToolExecutionResult>;
}

export type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

export interface ScenarioWriter {
  /** The create route's core, as the writer's sidebar and link Create call it. */
  create(
    path: string,
    options?: {
      documentId?: DocumentId;
      content?: string;
      /** Create in this Work's Scratch (`scratch://@slug/path`) instead of a project source. */
      inScratchOf?: ScenarioWork;
    },
  ): Promise<{ status: "created" | "conflict"; documentId?: string }>;
  mkdir(path: string): Promise<void>;
  /** The sidebar's rename or move: commits `from`'s exact identity at `to`. */
  move(from: string, to: string): ReturnType<ContextPort["commitWriterLocation"]>;
  /** The sidebar's delete of the file or folder at `path` (recursive for a folder). */
  delete(path: string): ReturnType<ContextPort["delete"]>;
  /** The writer saves the whole document live, as the editor's Markdown save does. */
  write(path: string, markdown: string): Promise<void>;
  /**
   * The writer types in the Work draft's review room for this document: `edit` changes a
   * copy of the branch, and its update goes through the room's durable admission.
   * Returns the branch.
   */
  editDraft(
    work: ScenarioWork,
    documentId: DocumentId,
    edit: (doc: Y.Doc) => void,
  ): Promise<{ branchId: string; generation: number }>;
}

/** What a reader sees through ContextFS: a writer's live port, or a Work thread's. */
export interface ScenarioView {
  stat(path: string): ReturnType<ContextPort["stat"]>;
  ls(path: string): ReturnType<ContextPort["list"]>;
  read(path: string): ReturnType<ContextPort["read"]>;
  search(query: string): ReturnType<ContextPort["search"]>;
  /** ContextFS's locate by id in the Manuscript source, in this view. */
  locate(documentId: DocumentId): Promise<{ path: string } | null>;
}

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
  /** The Work draft's branch of this document, as its review room names it. */
  draftBranch(
    work: ScenarioWork,
    documentId: DocumentId,
  ): Promise<{ branchId: string; generation: number }>;
  /** The Work's active draft, made at the write boundary if absent. */
  draftOf(work: ScenarioWork): Promise<Draft>;
  /** Another thread whose primary Work is `work`. */
  thread(work: ScenarioWork): Promise<ScenarioWork>;
  // Command verbs: they need `options.runtime`.
  model(work: ScenarioWork): ScenarioModel;
  writer: ScenarioWriter;
  view(of: ScenarioWork | "live"): ScenarioView;
  /**
   * Discard these documents from the Work's draft through the review command (lane D
   * replaces what it calls with `discardItems`).
   */
  discard(work: ScenarioWork, documentIds: readonly DocumentId[]): Promise<void>;
  /** Apply these documents from the Work's draft through the review command (lane E's seam). */
  apply(work: ScenarioWork, documentIds: readonly DocumentId[]): Promise<void>;
  /**
   * Controlled interleaving: run `a` until it reaches the hook point `at`, run `b` to
   * completion or to its first lock wait, then release `a`.
   */
  interleave(
    a: () => Promise<unknown>,
    at: TreeHookPoint,
    b: () => Promise<unknown>,
  ): Promise<{ a: Settled; b: Settled; bWaited: boolean }>;
}

const SOURCES: readonly ScenarioSource[] = ["manuscript", "kb", "unfiled"];

export async function draftTreeScenario(
  db: Database,
  options: { runtime?: ScenarioRuntime; runtimes?: ComposedRuntimes } = {},
): Promise<DraftTreeScenario> {
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

  function runtime(): { runtime: ScenarioRuntime; runtimes: ComposedRuntimes } {
    if (!options.runtime || !options.runtimes) {
      throw new Error("Command verbs need draftTreeScenario(db, { runtime, runtimes })");
    }
    return { runtime: options.runtime, runtimes: options.runtimes };
  }

  function uri(path: string): string {
    return /^[a-z]+:\/\//.test(path) ? path : `manuscript://${path}`;
  }

  const human = () => ({ type: "human" as const, userId });

  function sourceOf(path: string): { scheme: "manuscript" | "kb" | "unfiled"; rel: string } {
    const match = /^(kb|unfiled|manuscript):\/\/(.*)$/.exec(path);
    return {
      scheme: (match?.[1] ?? "manuscript") as "manuscript" | "kb" | "unfiled",
      rel: match?.[2] ?? path,
    };
  }

  function model(work: ScenarioWork): ScenarioModel {
    async function reply(): Promise<ScenarioReply> {
      const { runtime: composed, runtimes } = runtime();
      const thread = { threadId: work.threadId, turnId: work.turnId };
      const { responseId, call } = await runtimes.script(composed, thread).begin();
      // The runtime loop's own lifecycle: its save and rollback retract staged creates.
      const lifecycle = composed.app.responseWrites;
      return {
        responseId,
        call,
        save: () => lifecycle.commitResponse(responseId, thread),
        rollback: () => lifecycle.rollbackResponse(responseId, thread),
      };
    }
    async function succeed(result: ToolExecutionResult) {
      if (result.isError) throw new Error(`model call failed: ${JSON.stringify(result.output)}`);
      return result;
    }
    return {
      reply,
      async create(path, text) {
        const turn = await reply();
        const created = await succeed(
          await turn.call("write", { command: "create", path: uri(path), content: text }),
        );
        await turn.save();
        const documentId = (created.metadata as { documentId?: unknown } | undefined)?.documentId;
        if (typeof documentId === "string") return documentId as DocumentId;
        const stat = await view(work).stat(path);
        if (!stat.ok || !stat.value.documentId) throw new Error(`create left no ${path}`);
        return stat.value.documentId as DocumentId;
      },
      async copy(from, to) {
        const turn = await reply();
        const copied = await succeed(
          await turn.call("write", { command: "copy", from: { path: uri(from) }, path: uri(to) }),
        );
        await turn.save();
        return copied;
      },
    };
  }

  const madeWorks: WorkId[] = [];

  /** The writer's live port, resolving `@slug` for every Work this scenario made. */
  async function livePort(): Promise<ContextPort> {
    const { ports } = runtime().runtime;
    const authorities = new Map<WorkSlug, ResolvedWorkAuthority>();
    for (const workId of madeWorks) {
      const authority = await ports.workAuthorityResolver.byId(projectId, workId);
      if (authority?.workSlug) authorities.set(authority.workSlug, authority);
    }
    return ports.contextPorts.forProject(projectId, userId, authorities);
  }

  const writer: ScenarioWriter = {
    async create(path, createOptions = {}) {
      const { scheme, rel } = createOptions.inScratchOf
        ? { scheme: "scratch" as const, rel: path }
        : sourceOf(path);
      const authority = createOptions.inScratchOf
        ? await runtime().runtime.ports.workAuthorityResolver.byId(
            projectId,
            createOptions.inScratchOf.id,
          )
        : null;
      const result = await createContextEntry({
        port: authority
          ? runtime().runtime.ports.contextPorts.forWork(
              authority,
              projectId,
              userId,
              authority.workSlug ? new Map([[authority.workSlug, authority]]) : new Map(),
            )
          : await livePort(),
        userId,
        scheme,
        ...(authority ? { authority } : {}),
        body: parseCreateContextEntryBody({
          type: "file",
          path: `/${rel}`,
          ...(createOptions.content !== undefined ? { content: createOptions.content } : {}),
          ...(createOptions.documentId ? { documentId: createOptions.documentId } : {}),
        }),
      });
      return result.status === "created"
        ? { status: "created", ...(result.documentId ? { documentId: result.documentId } : {}) }
        : { status: "conflict" };
    },
    async mkdir(path) {
      const { scheme, rel } = sourceOf(path);
      await createContextEntry({
        port: await livePort(),
        userId,
        scheme,
        body: parseCreateContextEntryBody({ type: "folder", path: `/${rel}` }),
      });
    },
    async move(from, to) {
      return (await livePort()).commitWriterLocation(uri(from), uri(to), { origin: human() });
    },
    async delete(path) {
      const port = await livePort();
      // stat answers files only; anything else at the path is the folder being deleted.
      const stat = await port.stat(uri(path));
      return port.delete(uri(path), {
        origin: human(),
        expected: stat.ok
          ? { kind: "file", documentId: stat.value.documentId ?? "" }
          : { kind: "folder" },
      });
    },
    async write(path, markdown) {
      const written = await (await livePort()).write(uri(path), markdown, {
        origin: human(),
      });
      if (!written.ok) throw new Error(JSON.stringify(written.error));
    },
    async editDraft(work, documentId, edit) {
      const sync = runtime().runtime.ports.documentSync;
      const room = await draftBranch(work, documentId);
      const document = new Y.Doc({ gc: false });
      const loaded = await sync.loadHocuspocusBranchState(room.branchId, room.generation);
      if (loaded) Y.applyUpdate(document, loaded.state);
      const before = Y.encodeStateVector(document);
      edit(document);
      await sync.admitBranchWriterUpdate({
        branchId: room.branchId,
        expectedGeneration: room.generation,
        update: Y.encodeStateAsUpdate(document, before),
        origin: { type: "user", userId },
        document,
      });
      return { branchId: room.branchId, generation: room.generation };
    },
  };

  async function draftBranch(work: ScenarioWork, documentId: DocumentId) {
    const review = runtime().runtime.ports.documentSync.draftReview;
    const item = (await review.list({ projectId, workId: work.id })).find(
      (candidate) => candidate.documentId === documentId,
    );
    if (!item) throw new Error(`No draft of ${documentId} in ${work.slug}`);
    const preview = await review.preview({
      projectId,
      workId: work.id,
      documentId,
      draftId: item.draftId,
    });
    if (preview.status !== "active") throw new Error(`The draft of ${documentId} is gone`);
    const room = parseYjsRoomName(preview.reviewRoomName);
    if (room?.kind !== "branch") throw new Error(`Not a branch room: ${preview.reviewRoomName}`);
    return { branchId: room.branchId, generation: room.generation };
  }

  function view(of: ScenarioWork | "live"): ScenarioView {
    const portFor = async (): Promise<ContextPort> => {
      if (of === "live") return livePort();
      const { ports } = runtime().runtime;
      const resolution = await resolveThreadContext(
        {
          threads: ports.threadRepos.threads,
          threadWorks: ports.threadRepos.threadWorks,
          works: ports.workRepo,
          workAuthorityResolver: ports.workAuthorityResolver,
        },
        of.threadId,
      );
      if (!resolution) throw new Error(`thread ${of.threadId} did not resolve`);
      return contextPortForThread(ports.contextPorts, resolution);
    };
    let resolved: Promise<ContextPort> | null = null;
    const port = () => {
      resolved ??= portFor();
      return resolved;
    };
    return {
      stat: async (path) => (await port()).stat(uri(path)),
      ls: async (path) => (await port()).list(uri(path)),
      read: async (path) => (await port()).read(uri(path)),
      search: async (query) => (await port()).search(query),
      async locate(documentId) {
        const { ports } = runtime().runtime;
        const store = createProjectContextDocumentStore(db, projectId, "manuscript", userId);
        const fs = new ContextFS({
          links: ports.linkScopes,
          store,
          mutationStore: new DrizzleContextTreeMutationStore(db),
          documentSync: ports.documentSync,
          scheme: "manuscript",
          holder: { projectId },
          placement:
            of === "live" || of.mode !== "draft"
              ? { kind: "live" }
              : {
                  kind: "draft",
                  workId: of.id,
                  threadId: of.threadId,
                  userId,
                  drafts: ports.documentSync.drafts,
                  creates: createDrizzleDraftCreates({
                    db,
                    sourceId: () => store.contextSourceId(),
                    documents: ports.documentSync,
                    branches: ports.documentSync,
                  }),
                },
        });
        const located = await fs.locateDocument(documentId);
        if (!located.ok) throw new Error(JSON.stringify(located.error));
        return located.value ? { path: located.value.path } : null;
      },
    };
  }

  async function discard(work: ScenarioWork, documentIds: readonly DocumentId[]) {
    const { ports } = runtime().runtime;
    const review = ports.documentSync.draftReview;
    const items = await review.list({ projectId, workId: work.id });
    for (const documentId of documentIds) {
      const item = items.find((candidate) => candidate.documentId === documentId);
      if (!item) throw new Error(`No draft of ${documentId} to discard`);
      await review.discardWorkDraft({
        projectId,
        workId: work.id,
        documentId,
        draftId: item.draftId,
        userId,
      });
    }
  }

  async function apply(work: ScenarioWork, documentIds: readonly DocumentId[]) {
    const review = runtime().runtime.ports.documentSync.draftReview;
    const items = await review.list({ projectId, workId: work.id });
    for (const documentId of documentIds) {
      const item = items.find((candidate) => candidate.documentId === documentId);
      if (!item) throw new Error(`No draft of ${documentId} to apply`);
      await review.applyWorkDraft({
        projectId,
        workId: work.id,
        documentId,
        draftId: item.draftId,
        userId,
      });
    }
  }

  /** Sessions of this database waiting on a lock. */
  async function lockWaiters(): Promise<number> {
    const [row] = await db.execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    return Number(row?.waiting ?? 0);
  }

  async function interleave(
    a: () => Promise<unknown>,
    at: TreeHookPoint,
    b: () => Promise<unknown>,
  ): Promise<{ a: Settled; b: Settled; bWaited: boolean }> {
    const settle = (run: () => Promise<unknown>): Promise<Settled> =>
      run().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let reached!: () => void;
    const atHook = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = setTreeHook(at, async () => {
      // Only `a`'s first arrival waits; `b` passes the same point freely.
      remove();
      reached();
      await gate;
    });
    try {
      const aRun = settle(a);
      const first = await Promise.race([atHook.then(() => "hook" as const), aRun]);
      if (first !== "hook") throw new Error(`a finished without reaching ${at}`);
      const before = await lockWaiters();
      const bRun = settle(b);
      const deadline = Date.now() + 5_000;
      let bDone = false;
      void bRun.then(() => {
        bDone = true;
      });
      let bWaited = false;
      while (!bDone && Date.now() < deadline) {
        if ((await lockWaiters()) > before) {
          bWaited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      release();
      return { a: await aRun, b: await bRun, bWaited };
    } finally {
      remove();
      release();
    }
  }

  async function linkAnswer(input: {
    view: ScenarioWork | "live";
    ref: string;
    href: string;
    baseUri: string | null;
    holderDocumentId?: DocumentId;
  }): Promise<{ answer: DocumentLinkAnswer; holderUri?: string }> {
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
      const { threadId, turnId } = await insertThread(name, work.id);
      madeWorks.push(work.id);
      return { id: work.id, slug, threadId, turnId, mode };
    },
    async thread(work) {
      const { threadId, turnId } = await insertThread(`${work.slug} (second)`, work.id);
      return { ...work, threadId, turnId };
    },
    model,
    writer,
    view,
    discard,
    apply,
    interleave,
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
    draftBranch,
    linkAnswer,
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
  };
}
