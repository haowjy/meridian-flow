import type { DocumentId, DocumentLinkAnswer, WorkId } from "@meridian/contracts";
import { canonicalContextUri, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DraftItem } from "@meridian/contracts/drafts";
import type { ResolvedWorkAuthority, WorkHandle } from "@meridian/contracts/works";
import { works } from "@meridian/database/schema";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { writerEdit } from "../domains/collab/test-support/live-room-text.js";
import {
  contextPortForThread,
  resolveThreadContext,
} from "../domains/context/context-port-resolution.js";
import type { ContextPort, GrepQuery } from "../domains/context/ports/context-port.js";
import type { ToolExecutionResult } from "../domains/runtime/tools/types.js";
import { handleDocumentLinkResolveRequest } from "../lib/document-link-route.js";
import { handleDraftListRequest, selectDraftRouteServices } from "../lib/draft-review-route.js";
import type { useComposedRuntimes } from "./composed-runtime.js";
import { type DraftTreeWorld, type ScenarioWork, sourceOf } from "./draft-tree-seeds.js";
import { deleteAt, entryAt, moveTo } from "./entry-ref.js";
import { treeSeeder } from "./tree-seed.js";

type ComposedRuntimes = ReturnType<typeof useComposedRuntimes>;
export type ScenarioRuntime = Awaited<ReturnType<ComposedRuntimes["compose"]>>;

export interface ScenarioReply {
  responseId: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}

export interface ScenarioModel {
  reply(): Promise<ScenarioReply>;
  now(name: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
  create(path: string, text: string): Promise<DocumentId>;
  copy(from: string, to: string): Promise<ToolExecutionResult>;
  edit(path: string, find: string, content: string): Promise<void>;
}

export interface ScenarioWriter {
  create(
    path: string,
    options?: {
      content?: string;
      inScratchOf?: ScenarioWork;
    },
  ): Promise<{ status: "created" | "conflict"; documentId?: string }>;
  createDocument(path: string, content: string): Promise<DocumentId>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): ReturnType<ContextPort["treeCommand"]>;
  delete(path: string): ReturnType<ContextPort["treeCommand"]>;
  write(path: string, markdown: string): Promise<void>;
  editLive(documentId: DocumentId, blocks: (schema: Schema) => readonly PMNode[]): Promise<void>;
}

export interface ScenarioView {
  stat(path: string): ReturnType<ContextPort["stat"]>;
  ls(path: string): ReturnType<ContextPort["list"]>;
  read(path: string): ReturnType<ContextPort["read"]>;
  grep(query: GrepQuery): ReturnType<ContextPort["grep"]>;
  locate(documentId: DocumentId): Promise<string | null>;
  text(path: string): Promise<string | null>;
  idAt(path: string): Promise<DocumentId | null>;
}

export interface DraftTreeCommands {
  model(work: ScenarioWork): ScenarioModel;
  writer: ScenarioWriter;
  view(of: ScenarioWork | "live"): ScenarioView;
  purge(work: ScenarioWork): Promise<number>;
  review(work: ScenarioWork): ReturnType<typeof handleDraftListRequest>;
  items(work: ScenarioWork): Promise<DraftItem[]>;
  linkAnswer(input: {
    view: ScenarioWork | "live";
    ref: string;
    href: string;
    baseUri: string | null;
    holderDocumentId?: DocumentId;
  }): Promise<{ answer: DocumentLinkAnswer; holderUri?: string }>;
  storedLinks(documentId: DocumentId): Promise<{ ref: string | null; href: string }[]>;
  liveMeaning(input: {
    ref: string;
    href: string;
    holder: { uri: string; id: DocumentId };
  }): Promise<{ id: string; inDraft?: true } | string>;
}

export function itemFor(items: readonly DraftItem[], documentId: DocumentId): DraftItem {
  const item = items.find((candidate) => candidate.documentId === documentId);
  if (!item) throw new Error(`no review item for ${documentId}`);
  return item;
}

function uri(path: string): string {
  const parsed = parseUnifiedContextUri(path);
  if (!parsed.ok)
    throw new Error(`Scenario path ${path} is not an address: ${parsed.error.reason}`);
  return parsed.value.normalized;
}

export function draftTreeCommands(
  world: DraftTreeWorld,
  composed: () => { runtime: ScenarioRuntime; runtimes: ComposedRuntimes },
): DraftTreeCommands {
  const { id: projectId, userId } = world.project;
  const human = () => ({ type: "human" as const, userId });
  const ports = () => composed().runtime.ports;

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
      const target = createOptions.inScratchOf ? canonicalContextUri("scratch", path) : uri(path);
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
    async editLive(documentId, blocks) {
      const schema = buildDocumentSchema();
      const { rooms } = ports().documentSync;
      await writerEdit(rooms, documentId, (current) => [...current, ...blocks(schema)]);
      await rooms.flush({ kind: "live", documentId });
    },
  };

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

  const routes = () => selectDraftRouteServices(composed().runtime.app);

  async function review(work: ScenarioWork) {
    return handleDraftListRequest(routes(), {
      projectId,
      draft: (await world.draftOf(work)).id,
      userId,
    });
  }

  async function purge(work: ScenarioWork) {
    const { runtime } = composed();
    await runtime.ports.workRepo.softDelete(work.id);
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
    purge,
    review,
    items: async (work) => (await review(work)).items,
    async storedLinks(documentId) {
      const read = await ports().documentSync.readEffectiveBlocks({
        documentId,
        destination: "live",
      });
      if (!read.ok) throw new Error(JSON.stringify(read.error));
      return walkLinkOccurrences(read.value.content).map(({ attrs }) => ({
        ref: attrs.ref,
        href: attrs.href,
      }));
    },
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
          }
        : answer.state;
    },
  };
}
