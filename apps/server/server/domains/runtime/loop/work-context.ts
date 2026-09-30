/** Renders and resolves the frozen model-facing Work context block. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import {
  isWorkArchived,
  type ThreadExecutionContext,
  type Work,
  workLifecycleState,
} from "@meridian/contracts/works";
import type { WorkRepository } from "../../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  threadExecutionContext,
} from "../../threads/index.js";

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

function boundedPromptText(value: string, limit: number, marker: string): string {
  if (value.length <= limit) return promptText(value);

  const contentLimit = limit - marker.length;
  let end = contentLimit;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
  return promptText(`${value.slice(0, end).trimEnd()}${marker}`);
}

function normalizedGoal(value: string | null): string | null {
  const normalized = (value ?? "").replace(/\r\n?/g, "\n").trim();
  return normalized || null;
}

function boundedGoal(value: string | null): string | null {
  const normalized = normalizedGoal(value);
  return normalized
    ? boundedPromptText(normalized, WORK_CONTEXT_GOAL_LIMIT, GOAL_TRUNCATION_MARKER)
    : null;
}

function workIdentity(work: Pick<Work, "slug" | "name">): string {
  return `${promptText(work.slug ?? "none")}: ${JSON.stringify(promptText(work.name))}`;
}

function currentWorkLines(
  work: Pick<Work, "slug" | "name" | "goal" | "status" | "archivedAt">,
): string[] {
  const identity = workIdentity(work);
  const status = work.status;
  const goal = boundedGoal(work.goal);
  if (status === null && goal === null && !isWorkArchived(work))
    return [`${identity} (goal: none)`];
  const lines = [identity];
  if (isWorkArchived(work)) {
    lines.push("  archived: this Work is read-only; use work unarchive before changing it.");
  }
  if (status !== null) lines.push(`  status: ${status}`);
  if (goal === null) lines.push("  goal: none");
  else lines.push("  goal: |", ...goal.split("\n").map((line) => `    ${line}`));
  return lines;
}

function currentLines(
  work: Pick<Work, "slug" | "name" | "goal" | "status" | "archivedAt" | "aiWriteMode" | "isNoWork">,
): string[] {
  if (work.isNoWork) return [`current: none (${work.aiWriteMode} writes)`];
  const [identity, ...goalLines] = currentWorkLines(work);
  return [`current: ${identity}`, ...goalLines];
}

export function renderWorkContext(input: {
  current: Pick<
    Work,
    "slug" | "name" | "goal" | "status" | "archivedAt" | "aiWriteMode" | "isNoWork"
  >;
}): string {
  return ["<work_context>", ...currentLines(input.current), "</work_context>"].join("\n");
}

export function createWorkContextReader(deps: {
  threads: Pick<ThreadRepository, "findById">;
  works: Pick<WorkRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
}): WorkContextReader {
  return {
    async renderForThread(threadId) {
      const thread = await deps.threads.findById(threadId);
      if (!thread || thread.deletedAt) throw new Error(`Thread unavailable: ${threadId}`);
      const primary = await deps.threadWorks.findPrimary(threadId);
      if (!primary) throw new Error(`Thread primary Work is missing: ${threadId}`);
      const current = await deps.works.findById(primary.workId);
      if (!current || workLifecycleState(current) === "deleted") {
        throw new Error(`Thread primary Work is unavailable: ${threadId}`);
      }
      const execution: ThreadExecutionContext = threadExecutionContext(current);
      return {
        text: renderWorkContext({ current }),
        current: { projectId: thread.projectId, execution },
      };
    },
  };
}
