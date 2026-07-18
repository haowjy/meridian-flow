/**
 * ContextPort resolution helpers: centralize the active-Work lookup that turns
 * thread or project-browse context into the correct unified ContextPort.
 */
import type { Thread } from "@meridian/contracts/threads";
import type { WorkRepository } from "../projects/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../threads/index.js";
import type { ContextPort } from "./ports/context-port.js";
import type { UnifiedContextPortFactory } from "./unified-context-port-factory.js";

export interface ThreadContextResolution {
  thread: Thread;
  primaryWorkId: string | null;
  workMemberships: ReadonlySet<string>;
}

export interface ThreadContextResolutionDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
}

export async function resolveThreadContext(
  deps: ThreadContextResolutionDeps,
  threadId: string,
): Promise<ThreadContextResolution | null> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return null;

  const primaryMembership = await deps.threadWorks.findPrimary(thread.id);
  if (!primaryMembership) {
    return { thread, primaryWorkId: null, workMemberships: new Set() };
  }

  const allMemberships = await deps.threadWorks.listByThread(thread.id);
  return {
    thread,
    primaryWorkId: primaryMembership.workId,
    workMemberships: new Set(allMemberships.map((membership) => membership.workId)),
  };
}

export function contextPortForThread(
  contextPorts: UnifiedContextPortFactory,
  resolution: ThreadContextResolution,
  options: { responseId?: string | null } = {},
): ContextPort {
  if (resolution.primaryWorkId) {
    return contextPorts.forWork(
      resolution.primaryWorkId,
      resolution.thread.projectId,
      resolution.thread.userId,
      resolution.workMemberships,
      resolution.thread.id,
      options.responseId,
    );
  }
  return contextPorts.forProject(resolution.thread.projectId, resolution.thread.userId);
}

export interface ProjectBrowseContextPortDeps {
  contextPorts: UnifiedContextPortFactory;
  works: Pick<WorkRepository, "findById" | "listByProject">;
}

/** Resolve the project-owned recovery surface across every active Work. */
export async function contextPortForProjectRecovery(input: {
  deps: ProjectBrowseContextPortDeps;
  projectId: string;
  userId: string;
  requestedWorkId?: string | null;
}): Promise<ContextPort> {
  const works = await input.deps.works.listByProject(input.projectId);
  const workIds = new Set(works.map((work) => work.id));
  const primaryWorkId = input.requestedWorkId ?? works[0]?.id ?? null;
  if (!primaryWorkId || !workIds.has(primaryWorkId)) {
    return input.deps.contextPorts.forProject(input.projectId, input.userId);
  }
  return input.deps.contextPorts.forWork(primaryWorkId, input.projectId, input.userId, workIds);
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
    return input.deps.contextPorts.forProject(input.projectId, input.userId);
  }
  if (!input.primaryWorkId || !input.workIds.has(input.primaryWorkId)) return null;
  const works = await Promise.all(
    [...input.workIds].map((workId) => input.deps.works.findById(workId)),
  );
  if (works.some((work) => !work || work.deletedAt || work.projectId !== input.projectId)) {
    return null;
  }
  return input.deps.contextPorts.forWork(
    input.primaryWorkId,
    input.projectId,
    input.userId,
    input.workIds,
  );
}

/**
 * Resolve a route-level context port after the caller has already proven
 * project ownership. The singleton authority set rejects authority-addressed
 * URIs for any other Work.
 */
export async function contextPortForProjectBrowse(input: {
  deps: ProjectBrowseContextPortDeps;
  projectId: string;
  userId: string;
  workId?: string | null;
}): Promise<ContextPort | null> {
  const workIds = new Set(input.workId ? [input.workId] : []);
  return contextPortForProjectAuthorities({
    ...input,
    workIds,
    primaryWorkId: input.workId,
  });
}
