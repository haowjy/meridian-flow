/**
 * The branch-tree DB tests' command verbs (contract §16.1): a model's replies, the writer's
 * route cores, readers' ports, and review commands, all driving the composed production
 * runtime (the real tool executor, route cores and ports) over a `BranchTreeWorld`.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources, or `user://` for the writer's personal source.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId, DocumentLinkAnswer, WorkId } from "@meridian/contracts";
import type { BranchCommandResult, ThreadDraftListItem } from "@meridian/contracts/branches";
import type { CreateUntitledContextDocumentAnswer } from "@meridian/contracts/protocol";
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
import {
  type CommandRouteResult,
  handleApplyAllWorkBranchRequest,
  handleApplyWorkDraftRequest,
  handleDiscardAllWorkBranchRequest,
  handleDiscardWorkDraftRequest,
  handleWorkBranchListRequest,
  selectBranchRouteServices,
} from "../lib/branch-review-route.js";
import { handleDocumentLinkResolveRequest } from "../lib/document-link-route.js";
import {
  createContextEntry,
  parseCreateContextEntryBody,
} from "../routes/api/projects/[projectId]/context/[scheme]/create.post.js";
import { createUntitledContextDocument } from "../routes/api/projects/[projectId]/context/[scheme]/create-untitled.post.js";
import { type BranchTreeWorld, type ScenarioWork, sourceOf } from "./branch-tree-seeds.js";
import { bindEditAgent, type useComposedRuntimes } from "./composed-runtime.js";
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
      content?: string;
      /** Create in this Work's Scratch (`scratch://@slug/path`) instead of a project source. */
      inScratchOf?: ScenarioWork;
    },
  ): Promise<{ status: "created" | "conflict"; documentId?: string }>;
  /**
   * The sidebar's New file: the create-untitled route's core with the typed destination,
   * under the id the device minted. `path` is Manuscript-relative.
   */
  createInstant(path: string, documentId: DocumentId): Promise<CreateUntitledContextDocumentAnswer>;
  /** The editor's New document: a nameless create into the Manuscript root. */
  createNameless(documentId: DocumentId): Promise<CreateUntitledContextDocumentAnswer>;
  /** `create` with content that must succeed; the document's id. */
  createDocument(path: string, content: string): Promise<DocumentId>;
  mkdir(path: string): Promise<void>;
  /** The sidebar's rename or move: commits `from`'s exact identity at `to`. */
  move(from: string, to: string): ReturnType<ContextPort["commitWriterLocation"]>;
  /**
   * The sidebar's delete of the file or folder at `path` (recursive for a folder). With an
   * `operationId`, its receipt is durable for `operation`.
   */
  delete(path: string, operationId?: string): ReturnType<ContextPort["delete"]>;
  /** The durable receipt of one namespace operation, as the replica's transport reads it. */
  operation(operationId: string): ReturnType<ContextPort["lookupOperation"]>;
  /** The writer saves the whole document live, as the editor's Markdown save does. */
  write(path: string, markdown: string): Promise<void>;
  /**
   * The writer types in this document's draft review room: `edit` changes a
   * copy of the draft, and its update goes through the room's durable admission.
   * Returns the draft.
   */
  editDraft(
    work: ScenarioWork,
    documentId: DocumentId,
    edit: (doc: Y.Doc) => void,
  ): Promise<{ draftId: string; generation: number }>;
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

export interface BranchTreeCommands {
  model(work: ScenarioWork): ScenarioModel;
  writer: ScenarioWriter;
  view(of: ScenarioWork | "live"): ScenarioView;
  /**
   * Discard through the route cores: `"all"` is Discard all for the Work's active branch
   * (or `branchId`); a list is the per-document Discard of each, in order.
   */
  discard(
    work: ScenarioWork,
    items: "all" | readonly DocumentId[],
    options?: { branchId?: string },
  ): Promise<BranchCommandResult | BranchCommandResult[]>;
  /**
   * Work purge (§2.6): the writer deletes the Work, its deletion ages past the cutoff, and
   * the purge sweep runs.
   */
  purge(work: ScenarioWork): Promise<number>;
  /** The Work's review list through its route core: the `items`. */
  review(work: ScenarioWork): ReturnType<typeof handleWorkBranchListRequest>;
  /** The review list's `items` only. */
  items(work: ScenarioWork): Promise<ThreadDraftListItem[]>;
  /** The statuses of every branch whose origin is the Work, oldest first. */
  branchStatuses(work: ScenarioWork): Promise<string[]>;
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
   * `inBranch` when they hold, else the answer's state (`missing`, `gone`, …).
   */
  liveMeaning(input: {
    ref: string;
    href: string;
    holder: { uri: string; id: DocumentId };
  }): Promise<{ id: string; inBranch?: true } | string>;
  /**
   * The per-document Apply route core, one call per document in order, each with the
   * tokens its item rendered unless `tokens` says otherwise (`none`: the legacy request).
   */
  apply(
    work: ScenarioWork,
    documentIds: readonly DocumentId[],
    options?: { tokens?: "rendered" | "none" },
  ): Promise<CommandRouteResult[]>;
  /**
   * The Apply all route core over the items the review list rendered (or `items`, as a
   * dock would send what it rendered earlier), for the Work's active branch (or `branchId`).
   */
  applyAll(
    work: ScenarioWork,
    options?: { items?: readonly ThreadDraftListItem[]; branchId?: string },
  ): Promise<BranchCommandResult>;
  /** The Work branch's draft of this document, as its review room names it. */
  documentDraft(
    work: ScenarioWork,
    documentId: DocumentId,
  ): Promise<{ draftId: string; generation: number }>;
}

/** The review item of `documentId`; throws when the list has none. */
export function itemFor(
  items: readonly ThreadDraftListItem[],
  documentId: DocumentId,
): ThreadDraftListItem {
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
function refOf(item: ThreadDraftListItem) {
  return {
    locationToken: item.tokens.locationToken,
    ...(item.tokens.liveTextToken === null ? {} : { liveTextToken: item.tokens.liveTextToken }),
    ...(item.tokens.draftGenerationToken === null
      ? {}
      : { draftGenerationToken: item.tokens.draftGenerationToken }),
  };
}

function uri(path: string): string {
  return /^[a-z]+:\/\//.test(path) ? path : `manuscript://${path}`;
}

/** Command verbs over `world`; `composed()` supplies the runtime (it throws when absent). */
export function branchTreeCommands(
  world: BranchTreeWorld,
  composed: () => { runtime: ScenarioRuntime; runtimes: ComposedRuntimes },
): BranchTreeCommands {
  const { id: projectId, userId } = world.project;
  const human = () => ({ type: "human" as const, userId });
  const ports = () => composed().runtime.ports;

  /** The resolve route's core over the composed app, as the route handler wires it. */
  async function linkAnswer(input: Parameters<BranchTreeCommands["linkAnswer"]>[0]) {
    const { app } = composed().runtime;
    const response = await handleDocumentLinkResolveRequest(
      {
        projectRepo: app.projectRepo,
        documentLinks: app.documentLinks,
        linkScopes: app.linkScopes,
        workAuthorityResolver: app.workAuthorityResolver,
        fileAccess: app.fileAccess,
        branches: app.documentSync.branches,
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
        save: () =>
          lifecycle.commitResponse(
            { providerResponseId: responseId, editScopeId: responseId },
            thread,
          ),
        rollback: () =>
          lifecycle.rollbackResponse(
            { providerResponseId: responseId, editScopeId: responseId },
            thread,
          ),
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
        }),
      });
      return result.status === "created"
        ? { status: "created", ...(result.documentId ? { documentId: result.documentId } : {}) }
        : { status: "conflict" };
    },
    async createInstant(path, documentId) {
      const segments = path.split("/").filter(Boolean);
      const name = segments.pop() ?? "";
      return createUntitledContextDocument({
        port: await livePort(),
        userId,
        scheme: "manuscript",
        workId: null,
        body: {
          documentId,
          destination: {
            parent: {
              kind: "root",
              scheme: "manuscript",
              owner: { workId: null },
              ...(segments.length ? { createFolders: segments } : {}),
            },
            name,
          },
        },
        destinationRootUri: "manuscript://",
      });
    },
    async createNameless(documentId) {
      return createUntitledContextDocument({
        port: await livePort(),
        userId,
        scheme: "manuscript",
        workId: null,
        body: { documentId },
      });
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
    async delete(path, operationId) {
      const port = await livePort();
      // stat answers files only; anything else at the path is the folder being deleted.
      const stat = await port.stat(uri(path));
      if (stat.ok) {
        return port.delete(uri(path), {
          origin: human(),
          ...(operationId ? { operationId } : {}),
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
        ...(operationId ? { operationId } : {}),
        expected: {
          kind: "folder",
          nodeId:
            folder.kind === "found" && folder.node.kind === "folder" ? folder.node.folder.id : "",
        },
      });
    },
    async operation(operationId) {
      return (await livePort()).lookupOperation(operationId);
    },
    async write(path, markdown) {
      const written = await (await livePort()).write(uri(path), markdown, {
        origin: human(),
      });
      if (!written.ok) throw new Error(JSON.stringify(written.error));
    },
    async editDraft(work, documentId, edit) {
      const sync = ports().documentSync;
      const room = await documentDraft(work, documentId);
      const document = new Y.Doc({ gc: false });
      const loaded = await sync.loadHocuspocusDraftState(room.draftId, room.generation);
      if (loaded) Y.applyUpdate(document, loaded.state);
      const before = Y.encodeStateVector(document);
      edit(document);
      await sync.admitDraftWriterUpdate({
        draftId: room.draftId,
        expectedGeneration: room.generation,
        update: Y.encodeStateAsUpdate(document, before),
        origin: { type: "user", userId },
        document,
      });
      return { draftId: room.draftId, generation: room.generation };
    },
  };

  async function documentDraft(work: ScenarioWork, documentId: DocumentId) {
    const review = ports().documentSync.draftReview;
    const item = await review.resolveItemByDocument({ workId: work.id, documentId });
    if (!item) throw new Error(`No draft of ${documentId} in ${work.slug}`);
    const preview = await review.preview({ workId: work.id, itemKey: item.itemKey });
    if (preview.status !== "active") throw new Error(`The draft of ${documentId} is gone`);
    const room = parseYjsRoomName(preview.reviewRoomName);
    if (room?.kind !== "draft") throw new Error(`Not a draft room: ${preview.reviewRoomName}`);
    return { draftId: room.draftId, generation: room.generation };
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
    run: (item: { documentId: DocumentId; branchId: string; itemKey: string }) => Promise<unknown>,
  ) {
    for (const documentId of documentIds) {
      const item = await ports().documentSync.draftReview.resolveItemByDocument({
        workId: work.id,
        documentId,
      });
      if (!item) throw new Error(`No draft of ${documentId} to ${verb}`);
      await run({ documentId, branchId: item.branchId, itemKey: item.itemKey });
    }
  }

  const routes = () => selectBranchRouteServices(composed().runtime.app);

  function review(work: ScenarioWork) {
    return handleWorkBranchListRequest(routes(), { projectId, workId: work.id, userId });
  }

  async function discard(
    work: ScenarioWork,
    items: "all" | readonly DocumentId[],
    options: { branchId?: string } = {},
  ) {
    if (items === "all") {
      const branchId =
        options.branchId ?? (await ports().documentSync.branches.activeForWork(work.id))?.id;
      if (!branchId) throw new Error(`${work.slug} has no branch to discard`);
      return (
        await handleDiscardAllWorkBranchRequest(routes(), {
          projectId,
          workId: work.id,
          userId,
          request: { branchId, commandId: randomUUID() },
        })
      ).body;
    }
    const results: BranchCommandResult[] = [];
    await eachItem(work, items, "discard", async ({ documentId, branchId, itemKey }) => {
      results.push(
        (
          await handleDiscardWorkDraftRequest(routes(), {
            projectId,
            workId: work.id,
            documentId,
            userId,
            request: { branchId, itemKey, commandId: randomUUID() },
          })
        ).body,
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
    documentDraft,
    discard,
    purge,
    review,
    items: async (work) => (await review(work)).items,
    async branchStatuses(work) {
      return (await world.branches.byOriginWork(work.id)).map((branch) => branch.status);
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
            ...(answer.inBranch ? { inBranch: true as const } : {}),
          }
        : answer.state;
    },
    async apply(work, documentIds, options = {}) {
      const { items } = await review(work);
      const results: CommandRouteResult[] = [];
      for (const documentId of documentIds) {
        const item = items.find((candidate) => candidate.documentId === documentId);
        if (!item?.draftGeneration) throw new Error(`No draft of ${documentId} to apply`);
        results.push(
          await handleApplyWorkDraftRequest(routes(), {
            projectId,
            workId: work.id,
            documentId,
            userId,
            request: {
              branchId: item.branchId,
              itemKey: item.itemKey,
              commandId: randomUUID(),
              ...(options.tokens === "none" ? {} : refOf(item)),
            },
          }),
        );
      }
      return results;
    },
    async applyAll(work, options = {}) {
      const listed = options.items ? null : await review(work);
      const items = options.items ?? listed?.items ?? [];
      const branchId =
        options.branchId ??
        items[0]?.branchId ??
        (await ports().documentSync.branches.activeForWork(work.id))?.id;
      if (!branchId) throw new Error(`${work.slug} has no branch to apply`);
      return (
        await handleApplyAllWorkBranchRequest(routes(), {
          projectId,
          workId: work.id,
          userId,
          request: {
            branchId,
            commandId: randomUUID() as never,
            items: items.map((item) => ({ itemKey: item.itemKey, ...refOf(item) })),
          },
        })
      ).body;
    },
  };
}
