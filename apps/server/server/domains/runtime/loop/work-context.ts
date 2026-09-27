/** Renders and resolves the frozen model-facing Work context block. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import type { ThreadExecutionContext, Work } from "@meridian/contracts/works";
import type { WorkRepository } from "../../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  threadExecutionContext,
} from "../../threads/index.js";

export const WORK_CONTEXT_ACTIVE_LIMIT = 20;
export const WORK_CONTEXT_GOAL_LIMIT = 2_000;
const GOAL_TRUNCATION_MARKER = "… [truncated]";

export interface RenderedWorkContext {
  text: string;
  current: { projectId: ProjectId; execution: ThreadExecutionContext };
}

export interface WorkContextReader {
  renderForThread(threadId: ThreadId): Promise<RenderedWorkContext>;
}

function promptText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function boundedGoal(value: string | null): string | null {
  const escaped = promptText((value ?? "").replace(/\r\n?/g, "\n").trim());
  if (!escaped) return null;
  if (escaped.length <= WORK_CONTEXT_GOAL_LIMIT) return escaped;

  const contentLimit = WORK_CONTEXT_GOAL_LIMIT - GOAL_TRUNCATION_MARKER.length;
  let end = contentLimit;
  if (end > 0 && /[\uD800-\uDBFF]/.test(escaped[end - 1] ?? "")) end -= 1;
  return `${escaped.slice(0, end).trimEnd()}${GOAL_TRUNCATION_MARKER}`;
}

function workLines(work: Pick<Work, "slug" | "name" | "goal">, indent = ""): string[] {
  const identity = `${indent}${promptText(work.slug ?? "none")}: ${JSON.stringify(promptText(work.name))}`;
  const goal = boundedGoal(work.goal);
  if (goal === null) return [`${identity} (goal: none)`];
  return [
    identity,
    `${indent}  goal: |`,
    ...goal.split("\n").map((line) => `${indent}    ${line}`),
  ];
}

function currentLines(
  work: Pick<Work, "slug" | "name" | "goal" | "aiWriteMode" | "isNoWork">,
): string[] {
  if (work.isNoWork) return [`current: none (${work.aiWriteMode} writes)`];
  const [identity, ...goalLines] = workLines(work);
  return [`current: ${identity}`, ...goalLines];
}

export function renderWorkContext(input: {
  current: Pick<Work, "id" | "slug" | "name" | "goal" | "aiWriteMode" | "isNoWork">;
  activeWorks: Array<Pick<Work, "id" | "slug" | "name" | "goal" | "lastActivityAt" | "isNoWork">>;
}): string {
  const otherActive = input.activeWorks
    .filter((work) => !work.isNoWork && work.id !== input.current.id)
    .sort(
      (left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        (left.slug ?? "").localeCompare(right.slug ?? ""),
    );
  const visible = otherActive.slice(0, WORK_CONTEXT_ACTIVE_LIMIT);
  const elided = otherActive.length - visible.length;
  const lines = [
    "<work_context>",
    ...currentLines(input.current),
    `active (most recent first; max ${WORK_CONTEXT_ACTIVE_LIMIT}):`,
    ...visible.flatMap((work) => workLines(work, "  ")),
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
      if (!primary) throw new Error(`Thread primary Work is missing: ${threadId}`);
      const current = await deps.works.findById(primary.workId);
      if (!current || current.deletedAt) {
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
