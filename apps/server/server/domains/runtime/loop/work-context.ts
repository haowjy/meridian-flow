/** Renders and resolves the frozen model-facing nullable Work context block. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import type { ThreadExecutionContext, Work } from "@meridian/contracts/works";
import type { WorkRepository } from "../../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  threadExecutionContext,
} from "../../threads/index.js";

export const WORK_CONTEXT_ACTIVE_LIMIT = 20;

export interface RenderedWorkContext {
  text: string;
  current: { projectId: ProjectId; execution: ThreadExecutionContext };
}

export interface WorkContextReader {
  renderForThread(threadId: ThreadId): Promise<RenderedWorkContext>;
}

function oneLine(value: string | null): string {
  return (value ?? "none").replace(/\s+/g, " ").trim() || "none";
}

function promptText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function workLine(work: Pick<Work, "slug" | "name" | "goal">): string {
  return `${promptText(work.slug)}: ${JSON.stringify(promptText(work.name))} (goal: ${promptText(oneLine(work.goal))})`;
}

export function renderWorkContext(input: {
  current: Pick<Work, "id" | "slug" | "name" | "goal"> | null;
  activeWorks: Array<Pick<Work, "id" | "slug" | "name" | "goal" | "lastActivityAt">>;
}): string {
  const otherActive = input.activeWorks
    .filter((work) => work.id !== input.current?.id)
    .sort(
      (left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        left.slug.localeCompare(right.slug),
    );
  const visible = otherActive.slice(0, WORK_CONTEXT_ACTIVE_LIMIT);
  const elided = otherActive.length - visible.length;
  const lines = [
    "<work_context>",
    input.current ? `current: ${workLine(input.current)}` : "current: none (direct writes)",
    `active (most recent first; max ${WORK_CONTEXT_ACTIVE_LIMIT}):`,
    ...visible.map((work) => `  ${workLine(work)}`),
  ];
  if (visible.length === 0) lines.push("  none");
  if (elided > 0) lines.push(`elided: ${elided} more active Works; use work list to see them.`);
  lines.push("</work_context>");
  return lines.join("\n");
}

export function createWorkContextReader(deps: {
  threads: Pick<ThreadRepository, "findById">;
  works: Pick<WorkRepository, "findById" | "listByProject">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
}): WorkContextReader {
  return {
    async renderForThread(threadId) {
      const thread = await deps.threads.findById(threadId);
      if (!thread || thread.deletedAt) throw new Error(`Thread unavailable: ${threadId}`);
      const primary = await deps.threadWorks.findPrimary(threadId);
      const current = primary ? await deps.works.findById(primary.workId) : null;
      if (primary && (!current || current.deletedAt)) {
        throw new Error(`Thread primary Work is unavailable: ${threadId}`);
      }
      const activeWorks = await deps.works.listByProject(thread.projectId, { status: "active" });
      const execution: ThreadExecutionContext = threadExecutionContext(current);
      return {
        text: renderWorkContext({ current, activeWorks }),
        current: { projectId: thread.projectId, execution },
      };
    },
  };
}
