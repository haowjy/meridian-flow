/** Renders and resolves the frozen model-facing Work context block. */
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import type { WorkRepository } from "../../projects/index.js";
import type { ThreadWorksRepository } from "../../threads/index.js";

export const WORK_CONTEXT_ACTIVE_LIMIT = 20;

export interface RenderedWorkContext {
  text: string;
  current: { projectId: ProjectId; workId: WorkId };
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
  current: Pick<Work, "id" | "slug" | "name" | "goal">;
  activeWorks: Array<Pick<Work, "id" | "slug" | "name" | "goal" | "lastActivityAt">>;
}): string {
  const otherActive = input.activeWorks
    .filter((work) => work.id !== input.current.id)
    .sort(
      (left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt) ||
        left.slug.localeCompare(right.slug),
    );
  const visible = otherActive.slice(0, WORK_CONTEXT_ACTIVE_LIMIT);
  const elided = otherActive.length - visible.length;
  const lines = [
    "<work_context>",
    `current: ${workLine(input.current)}`,
    `active (most recent first; max ${WORK_CONTEXT_ACTIVE_LIMIT}):`,
    ...visible.map((work) => `  ${workLine(work)}`),
  ];
  if (visible.length === 0) lines.push("  none");
  if (elided > 0) lines.push(`elided: ${elided} more active Works; use work list to see them.`);
  lines.push("</work_context>");
  return lines.join("\n");
}

export function createWorkContextReader(deps: {
  works: Pick<WorkRepository, "findById" | "listByProject">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
}): WorkContextReader {
  async function currentForThread(threadId: ThreadId): Promise<Work> {
    const primary = await deps.threadWorks.findPrimary(threadId);
    if (!primary) throw new Error(`Thread has no primary Work: ${threadId}`);
    const current = await deps.works.findById(primary.workId);
    if (!current || current.deletedAt) {
      throw new Error(`Thread primary Work is unavailable: ${threadId}`);
    }
    return current;
  }
  return {
    async renderForThread(threadId) {
      const current = await currentForThread(threadId);
      const activeWorks = await deps.works.listByProject(current.projectId, { status: "active" });
      return {
        text: renderWorkContext({ current, activeWorks }),
        current: { projectId: current.projectId, workId: current.id },
      };
    },
  };
}
