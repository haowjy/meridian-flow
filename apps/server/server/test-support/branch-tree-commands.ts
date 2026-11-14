/**
 * The branch-tree DB tests' command verbs (contract §16.1): a model's replies, the writer's
 * route cores, readers' ports, and review commands, all driving the composed production
 * runtime (the real tool executor, route cores and ports) over a `BranchTreeWorld`.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources, or `user://` for the writer's personal source.
 */
import { randomUUID } from "node:crypto";
import {
  type BranchId,
  type DocumentId,
  type DocumentLinkAnswer,
  draftOwnerKey,
  type WorkId,
} from "@meridian/contracts";
import type { DiscardCommandResult, ThreadDraftListItem } from "@meridian/contracts/branches";
import type { ResolvedWorkAuthority, WorkHandle } from "@meridian/contracts/works";
import { works } from "@meridian/database/schema";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { ContextPort, GrepQuery } from "../domains/context/ports/context-port.js";
import type { ToolExecutionResult } from "../domains/runtime/tools/types.js";
import {
  handleDiscardBranchRequest,
  handleDiscardWorkDraftRequest,
  handleOwnerDraftListRequest,
  selectBranchRouteServices,
} from "../lib/branch-review-route.js";
import { handleDocumentLinkResolveRequest } from "../lib/document-link-route.js";
import { type BranchTreeWorld, type ScenarioWork, sourceOf } from "./branch-tree-seeds.js";
import type { useComposedRuntimes } from "./composed-runtime.js";
import { deleteAt, entryAt, moveTo } from "./entry-ref.js";
import { treeSeeder } from "./tree-seed.js";

type ComposedRuntimes = ReturnType<typeof useComposedRuntimes>;
export type ScenarioRuntime = Awaited<ReturnType<ComposedRuntimes["compose"]>>;

/** One model reply on a Work's thread: its tool calls, each committed as it runs. */
export interface ScenarioReply {
  responseId: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
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
      /** Create in this Work's Scratch (`scratch://@w3/path`) instead of a project source. */
      inScratchOf?: ScenarioWork;
    },
  ): Promise<{ status: "created" | "conflict"; documentId?: string }>;
  /** `create` with content that must succeed; the document's id. */
  createDocument(path: string, content: string): Promise<DocumentId>;
  mkdir(path: string): Promise<void>;
  /** The sidebar's rename or move: commits `from`'s exact identity at `to`. */
  move(from: string, to: string): ReturnType<ContextPort["treeCommand"]>;
  /** The sidebar's delete of the file or folder at `path` (recursive for a folder). */
  delete(path: string): ReturnType<ContextPort["delete"]>;
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
  ): Promise<{ draftId: string }>;
}

/** What a reader sees through its context port: a writer's live port, or a Work thread's. */
export interface ScenarioView {
  stat(path: string): ReturnType<ContextPort["stat"]>;
  ls(path: string): ReturnType<ContextPort["list"]>;
  read(path: string): ReturnType<ContextPort["read"]>;
  grep(query: GrepQuery): ReturnType<ContextPort["grep"]>;
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
  ): Promise<DiscardCommandResult | DiscardCommandResult[]>;
  /**
   * Work purge (§2.6): the writer deletes the Work, its deletion ages past the cutoff, and
   * the purge sweep runs.
   */
  purge(work: ScenarioWork): Promise<number>;
  /** The Work's review list through its route core: the `items`. */
  review(work: ScenarioWork): ReturnType<typeof handleOwnerDraftListRequest>;
  /** The review list's `items` only. */
  items(work: ScenarioWork): Promise<ThreadDraftListItem[]>;
  /** The statuses of every branch whose origin is the Work, oldest first. */
  branchStatuses(work: ScenarioWork): Promise<string[]>;
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
  /** The Work branch's draft of this document, as its review room names it. */
  documentDraft(work: ScenarioWork, documentId: DocumentId): Promise<{ draftId: string }>;
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
        documentTrash: app.documentTrash,
        files: app.uploadIdentity,
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
      return { responseId, call };
    }
    async function succeed(result: ToolExecutionResult) {
      if (result.isError) throw new Error(`model call failed: ${JSON.stringify(result.content)}`);
      return result;
    }
    return {
      reply,
      async now(name, args) {
        const { runtime, runtimes } = composed();
        const { call } = await runtimes.script(runtime, work).begin();
        return call(name, args);
      },
      async create(path, text) {
        const turn = await reply();
        const created = await succeed(
          await turn.call("write", { command: "create", path: uri(path), content: text }),
        );
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
        return copied;
      },
      async edit(path, find, content) {
        const turn = await reply();
        await succeed(await turn.call("read", { path: uri(path) }));
        await succeed(
          await turn.call("write", { command: "replace", path: uri(path), find, content }),
        );
      },
    };
  }

  /** The writer's live port, resolving `@w3` for every Work the world made. */
  async function livePort(): Promise<ContextPort> {
    const authorities = new Map<WorkHandle, ResolvedWorkAuthority>();
    for (const workId of world.works()) {
      const authority = await ports().workAuthorityResolver.byId(projectId, workId as WorkId);
      if (authority?.workHandle) authorities.set(authority.workHandle, authority);
    }
    return ports().contextPorts.forProject(projectId, userId, authorities);
  }

  const writer: ScenarioWriter = {
    async create(path, createOptions = {}) {
      const authority = createOptions.inScratchOf
        ? await ports().workAuthorityResolver.byId(projectId, createOptions.inScratchOf.id)
        : null;
      const port = authority
        ? ports().contextPorts.forWork(
            authority,
            projectId,
            userId,
            authority.workHandle ? new Map([[authority.workHandle, authority]]) : new Map(),
          )
        : await livePort();
      const target = createOptions.inScratchOf ? `scratch://${path}` : uri(path);
      const created = await port.createTrackedDocument(target, createOptions.content ?? "", {
        origin: human(),
      });
      if (created.ok) return { status: "created", documentId: created.value.documentId };
      if (created.error.code === "conflict") return { status: "conflict" };
      throw new Error(`${target}: ${JSON.stringify(created.error)}`);
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
      await treeSeeder(world.db).folder(world.project.sources[scheme], rel);
    },
    async move(from, to) {
      const port = await livePort();
      return moveTo(port, uri(from), uri(to), {
        origin: human(),
        expected: await entryAt(port, uri(from)),
      });
    },
    async delete(path) {
      const port = await livePort();
      return deleteAt(port, uri(path), {
        origin: human(),
        expected: await entryAt(port, uri(path)),
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
      const room = await documentDraft(work, documentId);
      const document = new Y.Doc({ gc: false });
      const loaded = await sync.loadHocuspocusDraftState(room.draftId);
      if (loaded) Y.applyUpdate(document, loaded.state);
      const before = Y.encodeStateVector(document);
      edit(document);
      await sync.admitDraftWriterUpdate({
        draftId: room.draftId,
        update: Y.encodeStateAsUpdate(document, before),
        origin: { type: "user", userId },
        document,
      });
      return { draftId: room.draftId };
    },
  };

  async function documentDraft(work: ScenarioWork, documentId: DocumentId) {
    const review = ports().documentSync.draftReview;
    const item = await review.resolveItemByDocument({
      owner: { kind: "work", workId: work.id },
      documentId,
    });
    if (!item) throw new Error(`No draft of ${documentId} in ${work.handle}`);
    if (!item.draftId || !item.item.hasDraft) throw new Error("Missing draft room");
    return { draftId: item.draftId };
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
      grep: async (query) => (await port()).grep(query),
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
        owner: { kind: "work", workId: work.id },
        documentId,
      });
      if (!item) throw new Error(`No draft of ${documentId} to ${verb}`);
      await run({ documentId, branchId: item.branchId, itemKey: item.itemKey });
    }
  }

  const routes = () => selectBranchRouteServices(composed().runtime.app);

  function review(work: ScenarioWork) {
    return handleOwnerDraftListRequest(routes(), {
      projectId,
      owner: draftOwnerKey({ kind: "work", workId: work.id }),
      userId,
    });
  }

  async function discard(
    work: ScenarioWork,
    items: "all" | readonly DocumentId[],
    options: { branchId?: string; ends?: "tree" | "item" } = {},
  ) {
    if (items === "all") {
      const branchId =
        options.branchId ??
        (await ports().documentSync.branches.activeForOwner({ kind: "work", workId: work.id }))?.id;
      if (!branchId) throw new Error(`${work.handle} has no branch to discard`);
      return (
        await handleDiscardBranchRequest(routes(), {
          projectId,
          branchId: branchId as BranchId,
          userId,
          request: { all: true, commandId: randomUUID() },
        })
      ).body;
    }
    const results: DiscardCommandResult[] = [];
    await eachItem(work, items, "discard", async ({ documentId, branchId, itemKey }) => {
      results.push(
        (
          await handleDiscardWorkDraftRequest(routes(), {
            projectId,
            branchId: branchId as BranchId,
            documentId,
            userId,
            request: { branchId, itemKey, commandId: randomUUID(), ends: options.ends ?? "item" },
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
  };
}
