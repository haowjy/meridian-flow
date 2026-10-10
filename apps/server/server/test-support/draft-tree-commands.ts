/**
 * The draft-tree DB tests' command verbs (contract §16.1): a model's replies, the writer's
 * route cores, readers' ports, and review commands, all driving the composed production
 * runtime (the real tool executor, route cores and ports) over a `DraftTreeWorld`.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources, or `user://` for the writer's personal source.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId, WorkId } from "@meridian/contracts";
import type { DraftApplyAllResponse, DraftReviewItemWire } from "@meridian/contracts/drafts";
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import type { ResolvedWorkAuthority, WorkSlug } from "@meridian/contracts/works";
import * as Y from "yjs";
import { collabHook } from "../domains/collab/domain/collab-test-hooks.js";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { ContextPort } from "../domains/context/ports/context-port.js";
import type { ToolExecutionResult } from "../domains/runtime/tools/types.js";
import {
  type DraftApplyRouteResult,
  handleApplyAllWorkDraftRequest,
  handleApplyWorkDraftRequest,
  handleWorkDraftListRequest,
  selectDraftRouteServices,
} from "../lib/draft-review-route.js";
import {
  createContextEntry,
  parseCreateContextEntryBody,
} from "../routes/api/projects/[projectId]/context/[scheme]/create.post.js";
import { runInDrizzleTransaction } from "../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../shared/work-lifecycle-lock.js";
import { bindEditAgent, type useComposedRuntimes } from "./composed-runtime.js";
import { type DraftTreeWorld, type ScenarioWork, sourceOf } from "./draft-tree-seeds.js";

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
}

export interface DraftTreeCommands {
  model(work: ScenarioWork): ScenarioModel;
  writer: ScenarioWriter;
  view(of: ScenarioWork | "live"): ScenarioView;
  /**
   * Discard these documents from the Work's draft through the review command (lane D
   * replaces what it calls with `discardItems`).
   */
  discard(work: ScenarioWork, documentIds: readonly DocumentId[]): Promise<void>;
  /** The Work's review list through its route core: the legacy `drafts` and the `items`. */
  review(work: ScenarioWork): ReturnType<typeof handleWorkDraftListRequest>;
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
  /**
   * Close the Work's active draft whole, as Discard all will (§2.1): every branch of the
   * draft leased first (hook `discard.afterLeases`), then the Work, the draft, the close.
   * Lane D's `discardItems` (whole) replaces this with the full kernel (§12.1).
   */
  closeDraft(work: ScenarioWork): Promise<void>;
  /** The Work draft's branch of this document, as its review room names it. */
  draftBranch(
    work: ScenarioWork,
    documentId: DocumentId,
  ): Promise<{ branchId: string; generation: number }>;
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

  async function closeDraft(work: ScenarioWork) {
    const { drafts, draftLeases } = ports().documentSync;
    const draft = await drafts.activeForWork(work.id);
    if (!draft) throw new Error(`${work.slug} has no active draft to close`);
    await draftLeases.withDraftBranches(draft.id, async () => {
      await collabHook("discard.afterLeases");
      await runInDrizzleTransaction(world.db, async () => {
        await requireLockedActiveWorks(world.db, [work.id]);
        if (!(await drafts.lockActive(draft.id))) return;
        await drafts.close(draft.id, new Date());
      });
    });
  }

  return {
    model,
    writer,
    view,
    draftBranch,
    closeDraft,
    discard: (work, documentIds) =>
      eachItem(work, documentIds, "discard", ({ documentId, draftId }) =>
        ports().documentSync.draftReview.discardWorkDraft({
          projectId,
          workId: work.id,
          documentId,
          draftId,
          userId,
        }),
      ),
    review,
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
