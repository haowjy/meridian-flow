/**
 * ContextPort resolution helpers: centralize the non-deleted Work lookup that turns
 * thread or project-browse context into the correct unified ContextPort.
 */

import type { DocumentVersion } from "@meridian/agent-edit";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { ResolvedWorkAuthority, WorkSlug } from "@meridian/contracts/works";
import type { WorkRef } from "../file-policy/index.js";
import type { ProjectWorkAuthorityResolver, WorkRepository } from "../projects/index.js";
import type {
  ThreadRepository,
  ThreadWorksRepository,
  TopPrimaryChatResolver,
} from "../threads/index.js";
import type { ChatUploadsOwners } from "./chat-uploads-owners.js";
import type { ContextPort, UploadsOwner } from "./ports/context-port.js";
import { scratchOwnerFor } from "./scratch-owner.js";
import type { UnifiedContextPortFactory } from "./unified-context-port-factory.js";

export interface ThreadContextResolution {
  thread: Thread;
  primaryWorkId: string | null;
  workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>;
  primaryWorkAuthority: ResolvedWorkAuthority | null;
  /** The thread's Work when the chat drafts AI writes; null in auto-apply. */
  primaryDraftWork: WorkRef | null;
  scratchLineages?: import("./scratch-owner.js").ScratchLineages;
  scratchOwner?: import("./scratch-owner.js").ScratchOwner;
  /** The chat whose uploads this thread's bare `uploads://` names; null for an unknown chat. */
  uploadsOwner: UploadsOwner | null;
  /** Finds another chat by its handle, for `uploads://@[c12]/` addresses. */
  uploadChats?: ChatUploadsOwners;
}

export interface ThreadContextResolutionDeps {
  scratchLineages?: import("./scratch-owner.js").ScratchLineages;
  /** Absent only in fixtures that never read uploads. */
  topPrimaryChats?: TopPrimaryChatResolver;
  uploadChats?: ChatUploadsOwners;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "listByProject" | "findById">;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

export async function resolveThreadContext(
  deps: ThreadContextResolutionDeps,
  threadId: string,
): Promise<ThreadContextResolution | null> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return null;

  const projectWorks = await deps.works.listByProject(thread.projectId, { lifecycle: "all" });
  const primaryMembership = await deps.threadWorks.findPrimary(thread.id);
  const authorities = await Promise.all(
    projectWorks.map((work) => deps.workAuthorityResolver.byId(thread.projectId, work.id)),
  );
  const primaryWorkAuthority = primaryMembership
    ? await deps.workAuthorityResolver.byId(thread.projectId, primaryMembership.workId)
    : null;
  const workAuthorities = new Map(
    authorities
      .filter(
        (authority): authority is ResolvedWorkAuthority & { workSlug: WorkSlug } =>
          authority != null && authority.workSlug !== null,
      )
      .map((authority) => [authority.workSlug, authority]),
  );
  // By id: the project listing leaves out No Work, whose chats can draft too.
  const primaryWork = primaryMembership
    ? await deps.works.findById(primaryMembership.workId)
    : null;
  const topChat = await deps.topPrimaryChats?.resolveTopPrimaryChat(thread.id);
  return {
    thread,
    uploadChats: deps.uploadChats,
    uploadsOwner: topChat ? { chatId: topChat.chatId, chatRef: topChat.chatRef } : null,
    scratchLineages: deps.scratchLineages,
    ...(primaryWork ? { scratchOwner: scratchOwnerFor(thread, primaryWork) } : {}),
    primaryWorkId: primaryMembership?.workId ?? null,
    workAuthorities,
    primaryWorkAuthority,
    primaryDraftWork:
      primaryWork && thread.aiWriteMode === "draft"
        ? { id: primaryWork.id, slug: primaryWork.slug }
        : null,
  };
}

export function contextPortForThread(
  contextPorts: UnifiedContextPortFactory,
  resolution: ThreadContextResolution,
  options: {
    responseId?: string | null;
    version?: DocumentVersion;
    /** Write live whatever the chat's mode, as a binary copy does (D24). */
    liveWrites?: boolean;
  } = {},
): ContextPort {
  if (!resolution.primaryWorkAuthority) {
    throw new Error(`Thread ${resolution.thread.id} has no primary Work`);
  }
  return contextPorts.forWork(
    resolution.primaryWorkAuthority,
    resolution.thread.projectId,
    resolution.thread.userId,
    resolution.workAuthorities,
    {
      scratchOwner: scratchOwnerFor(resolution.thread, {
        id: resolution.primaryWorkAuthority.workId,
        isNoWork: resolution.primaryWorkAuthority.workSlug === null,
      }),
      ...(resolution.uploadsOwner ? { uploadsOwner: resolution.uploadsOwner } : {}),
      threadId: resolution.thread.id,
      responseId: options.responseId,
      draftWork: options.liveWrites ? null : resolution.primaryDraftWork,
      ...(options.version ? { version: options.version } : {}),
    },
  );
}

export interface ProjectBrowseContextPortDeps {
  contextPorts: UnifiedContextPortFactory;
  works: Pick<WorkRepository, "listByProject" | "findById">;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

async function resolvedAuthorities(
  deps: ProjectBrowseContextPortDeps,
  projectId: string,
  works: Awaited<ReturnType<WorkRepository["listByProject"]>>,
): Promise<Map<WorkSlug, ResolvedWorkAuthority>> {
  const resolved = await Promise.all(
    works.map((work) => deps.workAuthorityResolver.byId(projectId, work.id)),
  );
  return new Map(
    resolved
      .filter(
        (value): value is ResolvedWorkAuthority & { workSlug: WorkSlug } =>
          value != null && value.workSlug !== null,
      )
      .map((value) => [value.workSlug, value]),
  );
}

/** Resolve the project-owned recovery surface across every non-deleted Work. */
export async function contextPortForProjectRecovery(input: {
  deps: ProjectBrowseContextPortDeps;
  projectId: string;
  userId: string;
  requestedWorkId?: string | null;
}): Promise<ContextPort> {
  const works = await input.deps.works.listByProject(input.projectId, { lifecycle: "all" });
  const workAuthorities = await resolvedAuthorities(input.deps, input.projectId, works);
  const primaryWorkId = input.requestedWorkId ?? null;
  const primaryAuthority = primaryWorkId
    ? await input.deps.workAuthorityResolver.byId(input.projectId, primaryWorkId)
    : null;
  if (!primaryWorkId || !primaryAuthority) {
    return input.deps.contextPorts.forProject(input.projectId, input.userId, workAuthorities);
  }
  return input.deps.contextPorts.forWork(
    primaryAuthority,
    input.projectId,
    input.userId,
    workAuthorities,
  );
}

/** Resolve one project-browse port whose Work authorities have all been proven. */
export async function contextPortForProjectAuthorities(input: {
  deps: ProjectBrowseContextPortDeps;
  projectId: string;
  userId: string;
  workIds: ReadonlySet<string>;
  primaryWorkId?: string | null;
  projectWorks?: Awaited<ReturnType<WorkRepository["listByProject"]>>;
}): Promise<ContextPort | null> {
  if (input.workIds.size === 0) {
    const works =
      input.projectWorks ??
      (await input.deps.works.listByProject(input.projectId, { lifecycle: "all" }));
    return input.deps.contextPorts.forProject(
      input.projectId,
      input.userId,
      await resolvedAuthorities(input.deps, input.projectId, works),
    );
  }
  if (!input.primaryWorkId || !input.workIds.has(input.primaryWorkId)) return null;
  const resolved = await Promise.all(
    [...input.workIds].map(async (workId) => {
      const authority = await input.deps.workAuthorityResolver.byId(input.projectId, workId);
      return [workId, authority] as const;
    }),
  );
  if (resolved.some(([, authority]) => !authority)) return null;
  const primaryAuthority = resolved.find(([workId]) => workId === input.primaryWorkId)?.[1];
  if (!primaryAuthority) return null;
  const works =
    input.projectWorks ??
    (await input.deps.works.listByProject(input.projectId, { lifecycle: "all" }));
  const workAuthorities = await resolvedAuthorities(input.deps, input.projectId, works);
  return input.deps.contextPorts.forWork(
    primaryAuthority,
    input.projectId,
    input.userId,
    workAuthorities,
  );
}

/**
 * Resolve a route-level context port after the caller has already proven
 * project ownership. The selected Work is primary, while every non-deleted Work in
 * the project remains addressable by slug.
 */
export async function contextPortForProjectBrowse(input: {
  deps: ProjectBrowseContextPortDeps;
  projectId: string;
  userId: string;
  workId?: string | null;
  rootThreadId?: string | null;
  /** A chat's id, possibly before its row exists: bare `uploads://` names its files. */
  chatId?: string | null;
}): Promise<ContextPort | null> {
  if (input.chatId) {
    if (input.workId || input.rootThreadId) return null;
    const works = await input.deps.works.listByProject(input.projectId, { lifecycle: "all" });
    const chat = await input.deps.contextPorts.topPrimaryChats.resolveTopPrimaryChat(
      input.chatId as ThreadId,
    );
    return input.deps.contextPorts.forProject(
      input.projectId,
      input.userId,
      await resolvedAuthorities(input.deps, input.projectId, works),
      undefined,
      { chatId: input.chatId, chatRef: chat?.chatRef ?? null },
    );
  }
  if (input.rootThreadId) {
    if (input.workId) return null;
    const lineage = await input.deps.contextPorts.lineages.byId(
      input.projectId,
      input.rootThreadId,
    );
    if (!lineage) return null;
    const works = await input.deps.works.listByProject(input.projectId, { lifecycle: "all" });
    return input.deps.contextPorts.forProject(
      input.projectId,
      input.userId,
      await resolvedAuthorities(input.deps, input.projectId, works),
      lineage,
    );
  }
  const workIds = new Set(input.workId ? [input.workId] : []);
  return contextPortForProjectAuthorities({
    ...input,
    workIds,
    primaryWorkId: input.workId,
  });
}
