/** Renders and resolves the frozen model-facing Work context block. */

import type { AgentPermission } from "@meridian/contracts/agents";
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import {
  type AiWriteMode,
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
import { mayChangeWorks } from "./permissions/action-policy.js";

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
  if (status !== null) lines.push(`  status: ${status}`);
  if (goal === null) lines.push("  goal: none");
  else lines.push("  goal: |", ...goal.split("\n").map((line) => `    ${line}`));
  return lines;
}

/**
 * Where this chat's AI writes land (D9, D62): the chat's mode over its Work.
 * An archived Work freezes its own scratch and draft (D29, D30); only an agent
 * the action policy lets unarchive is offered that, and only a draft-mode chat
 * has auto-apply as a way out (D31). One description, two presentations: the
 * Work context's `writes:` line and the switch notice.
 */
export function describeWriteMode(input: {
  mode: AiWriteMode;
  archived: boolean;
  mayUnarchive: boolean;
  /** The chat has no Work, so its drafts are shared with the project's other chats that have none. */
  noWork: boolean;
}): { label: string; instructions: string[] } {
  if (input.archived) {
    if (!input.mayUnarchive) {
      return {
        label: "archived",
        instructions: [
          "This Work's scratch:// is frozen and your permission is read, so you can't change any file here. Ask the user to unarchive it if you need to.",
        ],
      };
    }
    if (input.mode === "direct") {
      return {
        label: "archived in auto-apply",
        instructions: [
          "Changes outside scratch:// are written straight into the writer's documents, but this Work's scratch:// and any draft it kept are frozen. To change those, unarchive it with work unarchive.",
        ],
      };
    }
    return {
      label: "archived in draft mode",
      instructions: [
        "This Work's draft and scratch:// are frozen, so your changes are refused. Unarchive it with work unarchive, or ask the user to switch this chat to auto-apply: changes outside scratch:// are then written straight into the writer's documents, and the draft stays frozen.",
      ],
    };
  }
  if (input.mode === "direct")
    return {
      label: "auto-apply",
      instructions: ["Your changes are written straight into the writer's documents."],
    };
  return {
    label: "draft mode",
    instructions: [
      "Your changes to a document wait in its draft for the writer to review, except scratch:// changes, which are written straight away. " +
        (input.noWork
          ? "The project's other chats that have no Work share these drafts."
          : "This Work's chats share these drafts."),
      "The writer reviews and applies each draft; until then only chats that share the drafts see their changes. When you draft a change, tell the user it is waiting for their review.",
    ],
  };
}

function writeModeLines(input: Parameters<typeof describeWriteMode>[0]): string[] {
  const { label, instructions } = describeWriteMode(input);
  const [first, ...rest] = instructions;
  return [`  writes: ${label}. ${first}`, ...rest.map((line) => `  ${line}`)];
}

type ContextWork = Pick<Work, "slug" | "name" | "goal" | "status" | "archivedAt" | "isNoWork">;

function currentLines(work: ContextWork, writes: string[]): string[] {
  if (work.isNoWork) return ["current: none", ...writes];
  const [identity, ...detailLines] = currentWorkLines(work);
  return [`current: ${identity}`, ...writes, ...detailLines];
}

export function renderWorkContext(input: {
  current: ContextWork;
  /** The chat's write mode (D62). */
  aiWriteMode: AiWriteMode;
  /** Whether the thread's agent chain may unarchive (D39). */
  mayUnarchive: boolean;
  rootThreadRef?: string;
}): string {
  const writes = writeModeLines({
    mode: input.aiWriteMode,
    archived: isWorkArchived(input.current),
    mayUnarchive: input.mayUnarchive,
    noWork: input.current.isNoWork,
  });
  return [
    "<work_context>",
    ...currentLines(input.current, writes),
    ...(input.rootThreadRef
      ? [
          input.current.isNoWork
            ? `  scratch: bare scratch:// is this chat's notes at scratch://@/${input.rootThreadRef}/, shared with its forks and subagents. A handoff starts fresh notes.`
            : `  scratch: bare scratch:// is this Work's notes at scratch://@${input.current.slug}/. Earlier chat notes remain at scratch://@/${input.rootThreadRef}/.`,
          "  Move notes to kb:// or manuscript:// to keep them for the project. Rebinding never moves notes.",
        ]
      : []),
    "</work_context>",
  ].join("\n");
}

export function createWorkContextReader(deps: {
  threads: Pick<ThreadRepository, "findById" | "findByIdIncludingDeleted">;
  works: Pick<WorkRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  readChainPermission(threadId: ThreadId): Promise<AgentPermission>;
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
      const root = await deps.threads.findByIdIncludingDeleted(thread.rootThreadId);
      const execution: ThreadExecutionContext = threadExecutionContext(current, thread.aiWriteMode);
      return {
        text: renderWorkContext({
          current,
          aiWriteMode: thread.aiWriteMode,
          rootThreadRef: root?.ref ?? undefined,
          mayUnarchive: mayChangeWorks(await deps.readChainPermission(threadId)),
        }),
        current: { projectId: thread.projectId, execution },
      };
    },
  };
}
