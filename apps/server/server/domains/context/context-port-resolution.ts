/**
 * ContextPort resolution helpers: centralize the non-deleted Work lookup that turns
 * thread or project-browse context into the correct unified ContextPort.
 */
import type { Thread } from "@meridian/contracts/threads";
import type { ResolvedWorkAuthority, WorkSlug } from "@meridian/contracts/works";
import type { ProjectWorkAuthorityResolver, WorkRepository } from "../projects/index.js";
import type { ThreadRepository, ThreadWorksRepository } from "../threads/index.js";
import type { ContextPort } from "./ports/context-port.js";
import type { UnifiedContextPortFactory } from "./unified-context-port-factory.js";

export interface ThreadContextResolution {
  thread: Thread;
  primaryWorkId: string | null;
  workAuthorities: ReadonlyMap<WorkSlug, ResolvedWorkAuthority>;
  primaryWorkAuthority: ResolvedWorkAuthority | null;
}

export interface ThreadContextResolutionDeps {
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "listByProject">;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}

export async function resolveThreadContext(
  deps: ThreadContextResolutionDeps,
  threadId: string,
): Promise<ThreadContextResolution | null> {
  const thread = await deps.threads.findById(threadId);
  if (!thread) return null;

  const projectWorks = await deps.works.listByProject(thread.projectId);
  const primaryMembership = await deps.threadWorks.findPrimary(thread.id);
  const authorities = await Promise.all(
    projectWorks.map((work) => deps.workAuthorityResolver.byId(thread.projectId, work.id)),
  );
  const primaryWorkAuthority = primaryMembership
    ? await deps.workAuthorityResolver.byId(thread.projectId, primaryMembership.workId)
    : null;
  const workAuthorities = new Map(
    authorities
      .filter((authority): authority is ResolvedWorkAuthority => authority !== null)
      .map((authority) => [authority.workSlug, authority]),
  );
  return {
    thread,
    primaryWorkId: primaryMembership?.workId ?? null,
    workAuthorities,
    primaryWorkAuthority,
  };
}

export function contextPortForThread(
  contextPorts: UnifiedContextPortFactory,
  resolution: ThreadContextResolution,
  options: { responseId?: string | null } = {},
): ContextPort {
  if (resolution.primaryWorkAuthority) {
    return contextPorts.forWork(
      resolution.primaryWorkAuthority,
      resolution.thread.projectId,
      resolution.thread.userId,
      resolution.workAuthorities,
      resolution.thread.id,
      options.responseId,
    );
  }
  return contextPorts.forProject(
    resolution.thread.projectId,
    resolution.thread.userId,
    resolution.workAuthorities,
  );
}

export interface ProjectBrowseContextPortDeps {
  contextPorts: UnifiedContextPortFactory;
  works: Pick<WorkRepository, "listByProject">;
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
      .filter((value): value is ResolvedWorkAuthority => value !== null)
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
  const works = await input.deps.works.listByProject(input.projectId);
  const workIds = new Set(works.map((work) => work.id));
  const workAuthorities = await resolvedAuthorities(input.deps, input.projectId, works);
  const primaryWorkId = input.requestedWorkId ?? null;
  const primaryAuthority = primaryWorkId
    ? await input.deps.workAuthorityResolver.byId(input.projectId, primaryWorkId)
    : null;
  if (!primaryWorkId || !workIds.has(primaryWorkId) || !primaryAuthority) {
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
    return input.deps.contextPorts.forProject(input.projectId, input.userId, new Map());
  }
  if (!input.primaryWorkId || !input.workIds.has(input.primaryWorkId)) return null;
  const works = input.projectWorks ?? (await input.deps.works.listByProject(input.projectId));
  const projectWorkIds = new Set(works.map((work) => work.id));
  if ([...input.workIds].some((workId) => !projectWorkIds.has(workId))) return null;
  const workAuthorities = await resolvedAuthorities(input.deps, input.projectId, works);
  const primaryAuthority = await input.deps.workAuthorityResolver.byId(
    input.projectId,
    input.primaryWorkId,
  );
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
