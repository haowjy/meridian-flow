/**
 * The draft-tree DB tests' command verbs (contract §16.1): a model's replies, the writer's
 * route cores, readers' ports, and review commands, all driving the composed production
 * runtime (the real tool executor, route cores and ports) over a `DraftTreeWorld`.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources, or `user://` for the writer's personal source.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId, DocumentLinkAnswer, WorkId } from "@meridian/contracts";
import type {
  DraftApplyAllResponse,
  DraftDiscardAllResponse,
  DraftDiscardResponse,
  DraftReviewItemWire,
} from "@meridian/contracts/drafts";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { ResolvedWorkAuthority, WorkSlug } from "@meridian/contracts/works";
import { branchPushSettlementBatches, works } from "@meridian/database/schema";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { ContextPort } from "../domains/context/ports/context-port.js";
import { createTreeReader, LIVE_TREE } from "../domains/context/tree/tree-view.js";
import type { ToolExecutionResult } from "../domains/runtime/tools/types.js";
import { handleDocumentLinkResolveRequest } from "../lib/document-link-route.js";
import {
  type DraftApplyRouteResult,
  handleApplyAllWorkDraftRequest,
  handleApplyWorkDraftRequest,
  handleDiscardAllWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  handleWorkDraftListRequest,
  selectDraftRouteServices,
} from "../lib/draft-review-route.js";
import {
  createContextEntry,
  parseCreateContextEntryBody,
} from "../routes/api/projects/[projectId]/context/[scheme]/create.post.js";
import { bindEditAgent, type useComposedRuntimes } from "./composed-runtime.js";
import { type DraftTreeWorld, type ScenarioWork, sourceOf } from "./draft-tree-seeds.js";
import { expirePendingSettlementClaims } from "./settlement-claims.js";

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
  /** One tool call outside any reply: a write commits at once (the pool's `commitNow`). */
  now(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
  /** One reply that creates `path` with `text` and saves; the created document's id. */
  create(path: string, text: string): Promise<DocumentId>;
  /** One reply that copies `from` to `to` and saves. */
  copy(from: string, to: string): Promise<ToolExecutionResult>;
  /** One saved reply that reads `path` and replaces `find` in it with `content`. */
  edit(path: string, find: string, content: string): Promise<void>;
}

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
  /** `create` with content that must succeed; the document's id. */
  createDocument(path: string, content: string): Promise<DocumentId>;
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

/** What a reader sees through its context port: a writer's live port, or a Work thread's. */
export interface ScenarioView {
  stat(path: string): ReturnType<ContextPort["stat"]>;
  ls(path: string): ReturnType<ContextPort["list"]>;
  read(path: string): ReturnType<ContextPort["read"]>;
  search(query: string): ReturnType<ContextPort["search"]>;
  /** Where this reader sees the document, by id: its URI, or null. */
  locate(documentId: DocumentId): Promise<string | null>;
  /** The text at `path`, or null when this reader has no file there. */
  text(path: string): Promise<string | null>;
  /** The document at `path`, or null. */
  idAt(path: string): Promise<DocumentId | null>;
}

export interface DraftTreeCommands {
  model(work: ScenarioWork): ScenarioModel;
  writer: ScenarioWriter;
  view(of: ScenarioWork | "live"): ScenarioView;
  /**
   * Discard through the route cores: `"all"` is Discard all for the Work's active draft
   * (or `draftId`); a list is the per-document Discard of each, in order.
   */
  discard(
    work: ScenarioWork,
    items: "all" | readonly DocumentId[],
    options?: { draftId?: string },
  ): Promise<DraftDiscardAllResponse | DraftDiscardResponse[]>;
  /**
   * Work purge (§2.6): the writer deletes the Work, its deletion ages past the cutoff, and
   * the purge sweep runs.
   */
  purge(work: ScenarioWork): Promise<number>;
  /** The Work's review list through its route core: the legacy `drafts` and the `items`. */
  review(work: ScenarioWork): ReturnType<typeof handleWorkDraftListRequest>;
  /** The review list's `items` only. */
  items(work: ScenarioWork): Promise<DraftReviewItemWire[]>;
  /** The statuses of every draft whose origin is the Work, oldest first. */
  draftStatuses(work: ScenarioWork): Promise<string[]>;
  /** Every settlement batch's state (they belong to no user: suites clear them per case). */
  batchStates(): Promise<string[]>;
  /** As if the warm owner died: its claim on every pending batch has expired. */
  expirePendingClaims(): Promise<void>;
  /** Recovery's pass over every recoverable batch; how many it settled. */
  recover(): Promise<number>;
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
  /** The stored links in a live document: each one's ref and href. */
  storedLinks(documentId: DocumentId): Promise<{ ref: string | null; href: string }[]>;
  /**
   * What a stored link means live from its holder (pinned by id): the document's id with
   * `inDraft`/`bound` when they hold, else the answer's state (`missing`, `gone`, …).
   */
  liveMeaning(input: {
    ref: string;
    href: string;
    holder: { uri: string; id: DocumentId };
  }): Promise<{ id: string; inDraft?: true; bound?: true } | string>;
  /**
   * The per-document Apply route core, one call per document in order, each with the
   * tokens its item rendered unless `tokens` says otherwise (`none`: the legacy request).
   */
  apply(
    work: ScenarioWork,
    documentIds: readonly DocumentId[],
    options?: { tokens?: "rendered" | "none" },
  ): Promise<DraftApplyRouteResult[]>;
  /**
   * The Apply all route core over the items the review list rendered (or `items`, as a
   * dock would send what it rendered earlier), for the Work's active draft (or `draftId`).
   */
  applyAll(
    work: ScenarioWork,
    options?: { items?: readonly DraftReviewItemWire[]; draftId?: string },
  ): Promise<DraftApplyAllResponse>;
  /** The Work draft's branch of this document, as its review room names it. */
  draftBranch(
    work: ScenarioWork,
    documentId: DocumentId,
  ): Promise<{ branchId: string; generation: number }>;
}

/** The review item of `documentId`; throws when the list has none. */
export function itemFor(
  items: readonly DraftReviewItemWire[],
  documentId: DocumentId,
): DraftReviewItemWire {
  const item = items.find((candidate) => candidate.documentId === documentId);
  if (!item) throw new Error(`no review item for ${documentId}`);
  return item;
}

/** A review-room edit that appends one paragraph linking `href` by `ahead:<aheadId>`. */
export function typeLink(href: string, aheadId: string) {
  return (doc: Y.Doc) => {
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Kael", { link: { href, ref: `ahead:${aheadId}`, title: null } });
    paragraph.insert(0, [text]);
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).push([paragraph]);
  };
}

/** The tokens an item rendered, as a request carries them. */
function refOf(item: DraftReviewItemWire) {
  return {
    locationToken: item.locationToken,
    ...(item.liveTextToken === null ? {} : { liveTextToken: item.liveTextToken }),
    ...(item.branchGenerationToken === null
      ? {}
      : { branchGenerationToken: item.branchGenerationToken }),
  };
}

function uri(path: string): string {
  return /^[a-z]+:\/\//.test(path) ? path : `manuscript://${path}`;
}

/** Command verbs over `world`; `composed()` supplies the runtime (it throws when absent). */
export function draftTreeCommands(
  world: DraftTreeWorld,
  composed: () => { runtime: ScenarioRuntime; runtimes: ComposedRuntimes },
): DraftTreeCommands {
  const { id: projectId, userId } = world.project;
  const human = () => ({ type: "human" as const, userId });
  const ports = () => composed().runtime.ports;

  /** The resolve route's core over the composed app, as the route handler wires it. */
  async function linkAnswer(input: Parameters<DraftTreeCommands["linkAnswer"]>[0]) {
    const { app } = composed().runtime;
    const response = await handleDocumentLinkResolveRequest(
      {
        projectRepo: app.projectRepo,
        documentLinks: app.documentLinks,
        linkScopes: app.linkScopes,
        workAuthorityResolver: app.workAuthorityResolver,
        fileAccess: app.fileAccess,
        drafts: app.documentSync.drafts,
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

  function model(work: ScenarioWork): ScenarioModel {
    async function reply(): Promise<ScenarioReply> {
      const { runtime, runtimes } = composed();
      const thread = { threadId: work.threadId, turnId: work.turnId };
      const { responseId, call } = await runtimes.script(runtime, thread).begin();
      // The runtime loop's own lifecycle: its save and rollback retract staged creates.
      const lifecycle = runtime.app.responseWrites;
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
      async now(name, args) {
        const { runtime } = composed();
        await bindEditAgent(runtime, work.threadId);
        return runtime.app.toolExecutor.executeTool(
          { id: randomUUID(), name, arguments: args },
          { threadId: work.threadId, turnId: work.turnId, agentSlug: null },
        );
      },
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
      async edit(path, find, content) {
        const turn = await reply();
        await succeed(await turn.call("read", { path: uri(path) }));
        await succeed(
          await turn.call("write", { command: "replace", path: uri(path), find, content }),
        );
        await turn.save();
      },
    };
  }

  /** The writer's live port, resolving `@slug` for every Work the world made. */
  async function livePort(): Promise<ContextPort> {
    const authorities = new Map<WorkSlug, ResolvedWorkAuthority>();
    for (const workId of world.works()) {
      const authority = await ports().workAuthorityResolver.byId(projectId, workId as WorkId);
      if (authority?.workSlug) authorities.set(authority.workSlug, authority);
    }
    return ports().contextPorts.forProject(projectId, userId, authorities);
  }

  const writer: ScenarioWriter = {
    async create(path, createOptions = {}) {
      const { scheme, rel } = createOptions.inScratchOf
        ? { scheme: "scratch" as const, rel: path }
        : sourceOf(path);
      const authority = createOptions.inScratchOf
        ? await ports().workAuthorityResolver.byId(projectId, createOptions.inScratchOf.id)
        : null;
      const result = await createContextEntry({
        port: authority
          ? ports().contextPorts.forWork(
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
    async createDocument(path, content) {
      const created = await writer.create(path, { content });
      if (created.status !== "created" || !created.documentId) {
        throw new Error(`the writer's ${path} was not created`);
      }
      return created.documentId as DocumentId;
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
      if (stat.ok) {
        return port.delete(uri(path), {
          origin: human(),
          expected: { kind: "file", documentId: stat.value.documentId ?? "" },
        });
      }
      const { scheme, rel } = sourceOf(path);
      const folder = await createTreeReader(world.db).resolvePath(LIVE_TREE, {
        contextSourceId: world.project.sources[scheme],
        path: rel,
      });
      return port.delete(uri(path), {
        origin: human(),
        expected: {
          kind: "folder",
          nodeId:
            folder.kind === "found" && folder.node.kind === "folder" ? folder.node.folder.id : "",
        },
      });
    },
    async write(path, markdown) {
      const written = await (await livePort()).write(uri(path), markdown, {
        origin: human(),
      });
      if (!written.ok) throw new Error(JSON.stringify(written.error));
    },
    async editDraft(work, documentId, edit) {
      const sync = ports().documentSync;
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
    const review = ports().documentSync.draftReview;
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
      const resolution = await resolveThreadContext(
        {
          threads: ports().threadRepos.threads,
          threadWorks: ports().threadRepos.threadWorks,
          works: ports().workRepo,
          workAuthorityResolver: ports().workAuthorityResolver,
        },
        of.threadId,
      );
      if (!resolution) throw new Error(`thread ${of.threadId} did not resolve`);
      return contextPortForThread(ports().contextPorts, resolution);
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
        const located = await (await port()).locate(documentId);
        if (!located.ok) throw new Error(JSON.stringify(located.error));
        return located.value?.uri ?? null;
      },
      async text(path) {
        const read = await (await port()).read(uri(path));
        if (read.ok) return read.value.content;
        if (read.error.code === "not_found") return null;
        throw new Error(`${uri(path)}: ${JSON.stringify(read.error)}`);
      },
      async idAt(path) {
        const stat = await (await port()).stat(uri(path));
        if (!stat.ok) {
          if (stat.error.code === "not_found") return null;
          throw new Error(`${uri(path)}: ${JSON.stringify(stat.error)}`);
        }
        if (!stat.value.documentId) throw new Error(`${uri(path)}: stat has no document id`);
        return stat.value.documentId as DocumentId;
      },
    };
  }

  /** Each document's review item in the Work, then `run` on it. */
  async function eachItem(
    work: ScenarioWork,
    documentIds: readonly DocumentId[],
    verb: string,
    run: (item: { documentId: DocumentId; draftId: string }) => Promise<unknown>,
  ) {
    const items = await ports().documentSync.draftReview.list({ projectId, workId: work.id });
    for (const documentId of documentIds) {
      const item = items.find((candidate) => candidate.documentId === documentId);
      if (!item) throw new Error(`No draft of ${documentId} to ${verb}`);
      await run({ documentId, draftId: item.draftId });
    }
  }

  const routes = () => selectDraftRouteServices(composed().runtime.app);

  function review(work: ScenarioWork) {
    return handleWorkDraftListRequest(routes(), { projectId, workId: work.id, userId });
  }

  async function discard(
    work: ScenarioWork,
    items: "all" | readonly DocumentId[],
    options: { draftId?: string } = {},
  ) {
    if (items === "all") {
      const draftId =
        options.draftId ?? (await ports().documentSync.drafts.activeForWork(work.id))?.id;
      if (!draftId) throw new Error(`${work.slug} has no draft to discard`);
      return handleDiscardAllWorkDraftRequest(routes(), {
        projectId,
        workId: work.id,
        userId,
        request: { draftId },
      });
    }
    const results: DraftDiscardResponse[] = [];
    await eachItem(work, items, "discard", async ({ documentId, draftId }) => {
      results.push(
        await handleDiscardWorkDraftRequest(routes(), {
          projectId,
          workId: work.id,
          documentId,
          draftId,
          userId,
        }),
      );
    });
    return results;
  }

  async function purge(work: ScenarioWork) {
    const { runtime } = composed();
    await runtime.ports.workRepo.softDelete(work.id);
    // Past the purge cutoff (30 days).
    await world.db
      .update(works)
      .set({ deletedAt: new Date(Date.now() - 32 * 24 * 60 * 60 * 1_000) })
      .where(eq(works.id, work.id));
    return runtime.app.recovery.purgeWorks();
  }

  return {
    model,
    writer,
    view,
    draftBranch,
    discard,
    purge,
    review,
    items: async (work) => (await review(work)).items,
    async draftStatuses(work) {
      return (await world.drafts.byOriginWork(work.id)).map((draft) => draft.status);
    },
    async batchStates() {
      return (
        await world.db
          .select({ state: branchPushSettlementBatches.state })
          .from(branchPushSettlementBatches)
      ).map((row) => row.state);
    },
    async expirePendingClaims() {
      await expirePendingSettlementClaims(world.db);
    },
    recover: () => ports().documentSync.recoverPendingLiveSettlements(),
    storedLinks: (documentId) =>
      ports().documentSync.withLiveDocument(documentId, async ({ doc }) =>
        extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)).map((link) => ({
          ref: link.ref,
          href: link.href,
        })),
      ),
    linkAnswer,
    async liveMeaning({ ref, href, holder }) {
      const { answer } = await linkAnswer({
        view: "live",
        ref,
        href,
        baseUri: holder.uri,
        holderDocumentId: holder.id,
      });
      return answer.state === "document"
        ? {
            id: answer.document.id,
            ...(answer.inDraft ? { inDraft: true as const } : {}),
            ...(answer.holderBound ? { bound: true as const } : {}),
          }
        : answer.state;
    },
    async apply(work, documentIds, options = {}) {
      const { items } = await review(work);
      const results: DraftApplyRouteResult[] = [];
      for (const documentId of documentIds) {
        const item = items.find((candidate) => candidate.documentId === documentId);
        if (!item?.draftBranchId) throw new Error(`No draft branch of ${documentId} to apply`);
        results.push(
          await handleApplyWorkDraftRequest(routes(), {
            projectId,
            workId: work.id,
            documentId,
            draftId: item.draftBranchId,
            userId,
            ...(options.tokens === "none" ? {} : { tokens: refOf(item) }),
          }),
        );
      }
      return results;
    },
    async applyAll(work, options = {}) {
      const listed = options.items ? null : await review(work);
      const items = options.items ?? listed?.items ?? [];
      const draftId =
        options.draftId ??
        items[0]?.draftId ??
        (await ports().documentSync.drafts.activeForWork(work.id))?.id;
      if (!draftId) throw new Error(`${work.slug} has no draft to apply`);
      return handleApplyAllWorkDraftRequest(routes(), {
        projectId,
        workId: work.id,
        userId,
        request: {
          draftId,
          items: items.map((item) => ({ itemKey: item.itemKey, ...refOf(item) })),
        },
      });
    },
  };
}
