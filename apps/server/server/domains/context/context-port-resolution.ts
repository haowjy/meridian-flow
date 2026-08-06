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
  workAuthorities: ReadonlyMap<string, string>;
}

export interface ThreadContextResolutionDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "listByProject">;
}

export async function resolveThreadContext(
  deps: ThreadContextResolutionDeps,
  threadId: string,
): Promise<ThreadContextResolution | null> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return null;

  const primaryMembership = await deps.threadWorks.findPrimary(thread.id);
  if (!primaryMembership) {
    return { thread, primaryWorkId: null, workAuthorities: new Map() };
  }

  const projectWorks = await deps.works.listByProject(thread.projectId);
  return {
    thread,
    primaryWorkId: primaryMembership.workId,
    workAuthorities: new Map(projectWorks.map((work) => [work.slug, work.id])),
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
      resolution.workAuthorities,
      resolution.thread.id,
      options.responseId,
    );
  }
  return contextPorts.forProject(resolution.thread.projectId, resolution.thread.userId);
}

export interface ProjectBrowseContextPortDeps {
  contextPorts: UnifiedContextPortFactory;
  works: Pick<WorkRepository, "listByProject">;
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
  const workAuthorities = new Map(works.map((work) => [work.slug, work.id]));
  const primaryWorkId = input.requestedWorkId ?? works[0]?.id ?? null;
  if (!primaryWorkId || !workIds.has(primaryWorkId)) {
    return input.deps.contextPorts.forProject(input.projectId, input.userId);
  }
  return input.deps.contextPorts.forWork(
    primaryWorkId,
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
    return input.deps.contextPorts.forProject(input.projectId, input.userId);
  }
  if (!input.primaryWorkId || !input.workIds.has(input.primaryWorkId)) return null;
  const works = input.projectWorks ?? (await input.deps.works.listByProject(input.projectId));
  const projectWorkIds = new Set(works.map((work) => work.id));
  if ([...input.workIds].some((workId) => !projectWorkIds.has(workId))) return null;
  return input.deps.contextPorts.forWork(
    input.primaryWorkId,
    input.projectId,
    input.userId,
    new Map(works.map((work) => [work.slug, work.id])),
  );
}

/**
 * Resolve a route-level context port after the caller has already proven
 * project ownership. The selected Work is primary, while every active Work in
 * the project remains addressable by slug.
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
