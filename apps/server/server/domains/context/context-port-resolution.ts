/**
 * ContextPort resolution helpers: centralize the non-deleted Work lookup that turns
 * thread or project-browse context into the correct unified ContextPort.
 */

import type { DocumentVersion } from "@meridian/agent-edit";
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { ResolvedWorkAuthority, Work, WorkHandle } from "@meridian/contracts/works";
import { chatOwner } from "../../shared/draft-owner.js";
import type { BranchOwnerRef } from "../file-policy/index.js";
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
  /** The primary Work's row, deleted ones included; null when the thread has no primary Work. */
  primaryWork: Work | null;
  workAuthorities: ReadonlyMap<WorkHandle, ResolvedWorkAuthority>;
  primaryWorkAuthority: ResolvedWorkAuthority | null;
  /** Who owns the drafts the chat writes: its Work, or its lineage with no Work; null in auto-apply. */
  primaryBranchOwner: BranchOwnerRef | null;
  scratchLineages?: import("./scratch-owner.js").ScratchLineages;
  scratchOwner?: import("./scratch-owner.js").ScratchOwner;
  /** The chat whose uploads this thread's bare `uploads://` names; null for an unknown chat. */
  uploadsOwner: UploadsOwner | null;
  /** Finds another chat by its handle, for `uploads://@c12/` addresses. */
  uploadChats?: ChatUploadsOwners;
}

export interface ThreadContextResolutionDeps {
  scratchLineages?: import("./scratch-owner.js").ScratchLineages;
  /** Absent only in fixtures that never read uploads. */
  topPrimaryChats?: TopPrimaryChatResolver;
  uploadChats?: ChatUploadsOwners;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "findById">;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

export async function resolveThreadContext(
  deps: ThreadContextResolutionDeps,
  threadId: string,
): Promise<ThreadContextResolution | null> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return null;

  const [workAuthorities, primaryMembership, topChat] = await Promise.all([
    resolvedAuthorities(deps, thread.projectId),
    deps.threadWorks.findPrimary(thread.id),
    deps.topPrimaryChats?.resolveTopPrimaryChat(thread.id),
  ]);
  const [primaryWorkAuthority, primaryWork] = primaryMembership
    ? await Promise.all([
        deps.workAuthorityResolver.byId(thread.projectId, primaryMembership.workId),
        // By id: the project listing leaves out No Work, whose chats can draft too.
        deps.works.findById(primaryMembership.workId),
      ])
    : [null, null];
  return {
    thread,
    uploadChats: deps.uploadChats,
    uploadsOwner: topChat ? { chatId: topChat.chatId, chatRef: topChat.chatRef } : null,
    scratchLineages: deps.scratchLineages,
    ...(primaryWork ? { scratchOwner: scratchOwnerFor(thread, primaryWork) } : {}),
    primaryWorkId: primaryMembership?.workId ?? null,
    primaryWork,
    workAuthorities,
    primaryWorkAuthority,
    primaryBranchOwner:
      primaryWork && thread.aiWriteMode === "draft"
        ? { owner: chatOwner(thread, primaryWork), handle: primaryWork.handle }
        : null,
  };
}

export function contextPortForThread(
  contextPorts: UnifiedContextPortFactory,
  resolution: ThreadContextResolution,
  options: {
    responseId?: string | null;
    version?: DocumentVersion;
    /** Write live whatever the chat's mode, as a binary copy does. */
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
        isNoWork: resolution.primaryWorkAuthority.workHandle === null,
      }),
      ...(resolution.uploadsOwner ? { uploadsOwner: resolution.uploadsOwner } : {}),
      threadId: resolution.thread.id,
      responseId: options.responseId,
      branchOwner: options.liveWrites ? null : resolution.primaryBranchOwner,
      ...(options.version ? { version: options.version } : {}),
    },
  );
}

export interface ProjectBrowseContextPortDeps {
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

async function resolvedAuthorities(
  deps: Pick<ProjectBrowseContextPortDeps, "workAuthorityResolver">,
  projectId: string,
): Promise<Map<WorkHandle, ResolvedWorkAuthority>> {
  const resolved = await deps.workAuthorityResolver.listForProject(projectId as ProjectId);
  return new Map(
    resolved
      .filter(
        (value): value is ResolvedWorkAuthority & { workHandle: WorkHandle } =>
          value.workHandle !== null,
      )
      .map((value) => [value.workHandle, value]),
  );
}

/** Resolve one project-browse port whose Work authorities have all been proven. */
export async function contextPortForProjectAuthorities(input: {
  deps: ProjectBrowseContextPortDeps;
  projectId: string;
  userId: string;
  workIds: ReadonlySet<string>;
  primaryWorkId?: string | null;
}): Promise<ContextPort | null> {
  if (input.workIds.size === 0) {
    return input.deps.contextPorts.forProject(
      input.projectId,
      input.userId,
      await resolvedAuthorities(input.deps, input.projectId),
    );
  }
  if (!input.primaryWorkId || !input.workIds.has(input.primaryWorkId)) return null;
  const [resolved, workAuthorities] = await Promise.all([
    Promise.all(
      [...input.workIds].map(async (workId) => {
        const authority = await input.deps.workAuthorityResolver.byId(input.projectId, workId);
        return [workId, authority] as const;
      }),
    ),
    resolvedAuthorities(input.deps, input.projectId),
  ]);
  if (resolved.some(([, authority]) => !authority)) return null;
  const primaryAuthority = resolved.find(([workId]) => workId === input.primaryWorkId)?.[1];
  if (!primaryAuthority) return null;
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
 * the project remains addressable by handle.
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
    const [workAuthorities, chat] = await Promise.all([
      resolvedAuthorities(input.deps, input.projectId),
      input.deps.contextPorts.topPrimaryChats.resolveTopPrimaryChat(input.chatId as ThreadId),
    ]);
    return input.deps.contextPorts.forProject(
      input.projectId,
      input.userId,
      workAuthorities,
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
    return input.deps.contextPorts.forProject(
      input.projectId,
      input.userId,
      await resolvedAuthorities(input.deps, input.projectId),
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
