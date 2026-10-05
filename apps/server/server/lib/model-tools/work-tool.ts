/**
 * The model `work` tool: list, show and change the project's Works. The action
 * policy decides each command (D39); a model `switch` always needs the
 * writer's approval (D37), so it only says why it can't happen or asks.
 */
import type { PermissionDeniedReason } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Work, WorkReceipt, WorkReceiptState } from "@meridian/contracts/works";
import { workLifecycleState } from "@meridian/contracts/works";
import { unknownWorkMessage } from "../../domains/context/context/router.js";
import {
  createWork,
  deleteWorkTransition,
  setWorkArchived,
  updateWorkTransition,
  WorkLifecycleUnavailableError,
  WorkNameRequiredError,
  WorkStatusInvalidError,
} from "../../domains/projects/index.js";
import {
  actionPolicy,
  mayChangeWorks,
  type ToolHandlerContext,
  type WorkCommand,
  workActionRefusal,
} from "../../domains/runtime/index.js";
import {
  isToolError,
  type ToolErrorOutput,
  type ToolWiringDeps,
  toolError,
} from "./tool-context.js";

/**
 * A Work as the model sees it. Write mode and pending changes use the
 * writer's words (draft mode, auto-apply), as the work context does.
 */
type ModelWork = Pick<
  Work,
  "slug" | "name" | "goal" | "status" | "archivedAt" | "createdAt" | "updatedAt" | "lastActivityAt"
> & { writes: "draft mode" | "auto-apply"; pendingChangeCount?: Work["unpushedChangeCount"] };

function modelWork(work: Work): ModelWork {
  const { slug, name, goal, status, archivedAt, createdAt, updatedAt, lastActivityAt } = work;
  return {
    slug,
    name,
    goal,
    status,
    archivedAt,
    writes: work.aiWriteMode === "draft" ? "draft mode" : "auto-apply",
    createdAt,
    updatedAt,
    lastActivityAt,
    ...(work.unpushedChangeCount !== undefined
      ? { pendingChangeCount: work.unpushedChangeCount }
      : {}),
  };
}

function receiptState(work: Work): WorkReceiptState {
  return {
    name: work.name,
    goal: work.goal,
    status: work.status,
    archived: work.archivedAt !== null,
  };
}

/** An update, archive or unarchive's result, with the receipt that undoes it. */
function updateReceipt({
  before,
  after,
  changed,
}: {
  before: Work;
  after: Work;
  changed: boolean;
}) {
  return {
    output: modelWork(after),
    metadata: {
      workReceipt: {
        operation: "update",
        category: "mutate",
        changed,
        workId: after.id,
        workName: after.name,
        before: receiptState(before),
        after: receiptState(after),
        inverse: changed
          ? { command: "update", workId: before.id, state: receiptState(before) }
          : null,
      } satisfies WorkReceipt,
    },
  };
}

async function workBySlug(
  deps: ToolWiringDeps,
  projectId: string,
  slug: string,
): Promise<Work | ToolErrorOutput> {
  const works = await deps.works.listByProject(projectId, { lifecycle: "all" });
  const work = works.find((candidate) => candidate.slug === slug);
  if (work) return work;
  return toolError({ code: "work_not_found", message: unknownWorkMessage(slug), workSlug: slug });
}

/**
 * The Work a `switch` names. An unknown Work points to `work list` (D51), an
 * archived one can't be switched to by anyone, and the chat's current Work
 * needs no switch.
 */
async function resolveSwitchTarget(
  deps: ToolWiringDeps,
  projectId: string,
  threadId: ThreadId,
  slug: string | null | undefined,
): Promise<{ work: Work } | { unchanged: { message: string } } | ToolErrorOutput> {
  let work: Work;
  if (slug) {
    const found = await workBySlug(deps, projectId, slug);
    if (isToolError(found)) return found;
    if (workLifecycleState(found) === "deleted") {
      return toolError({
        code: "work_not_found",
        message: unknownWorkMessage(slug),
        workSlug: slug,
      });
    }
    work = found;
  } else {
    const noWork = await deps.works.findNoWork(projectId);
    if (!noWork) return toolError({ message: "No Work is missing for this project" });
    work = noWork;
  }
  const named = work.slug ? `@${work.slug}` : "No Work";
  if (workLifecycleState(work) === "archived") {
    return toolError({
      code: "work_archived",
      message: `Work ${named} is archived, so this chat can't switch to it until the user unarchives it.`,
    });
  }
  const current = await deps.threadWorks.findPrimary(threadId);
  const currentId = current?.workId ?? (work.isNoWork ? work.id : null);
  if (currentId === work.id) return { unchanged: { message: `This chat is already in ${named}.` } };
  return { work };
}

/**
 * A `work` command on an archived or gone Work. Offers the unarchive call only
 * when the action policy would allow it.
 */
function workLifecycleMessage(
  reason: "work_archived" | "work_deleted" | "work_missing",
  workSlug: string | null,
  mayUnarchive: boolean,
): string {
  if (reason !== "work_archived") {
    return workSlug ? `Work @${workSlug} is unavailable.` : "The requested Work is unavailable.";
  }
  if (!workSlug) return "The requested Work is archived and read-only.";
  return mayUnarchive
    ? `Work @${workSlug} is archived and read-only. Unarchive it with \`work({"command":"unarchive","work":"${workSlug}"})\` before changing it.`
    : `Work @${workSlug} is archived and read-only. Ask the user to unarchive @${workSlug}.`;
}

function policyRefusal(command: WorkCommand, decision: "ask" | "deny"): ToolErrorOutput {
  return toolError({
    code: "permission_denied",
    reason: "action_denied" satisfies PermissionDeniedReason,
    message: workActionRefusal(command, decision),
  });
}

type CommandName = Exclude<WorkCommand["command"], "switch">;
type CommandOf<C extends CommandName> = Extract<WorkCommand, { command: C }>;
type CommandHandler<C extends CommandName> = (
  deps: ToolWiringDeps,
  thread: Thread,
  command: CommandOf<C>,
) => Promise<unknown>;

/** A command on one named Work: an unknown slug points to `work list` (D51). */
function onSelectedWork<C extends Exclude<CommandName, "list" | "create">>(
  run: (
    deps: ToolWiringDeps,
    thread: Thread,
    work: Work,
    command: CommandOf<C>,
  ) => Promise<unknown>,
): CommandHandler<C> {
  return async (deps, thread, command) => {
    const { work: slug } = command as unknown as { work: string };
    const selected = await workBySlug(deps, thread.projectId, slug);
    return isToolError(selected) ? selected : run(deps, thread, selected, command);
  };
}

function archiving<C extends "archive" | "unarchive">(archived: boolean) {
  return onSelectedWork<C>(async (deps, thread, work) =>
    updateReceipt(
      await setWorkArchived(
        { works: deps.works, workContextNotices: deps.workContextNotices },
        work.id,
        archived,
        { originThreadId: thread.id },
      ),
    ),
  );
}

const COMMANDS: { [C in CommandName]: CommandHandler<C> } = {
  async list(deps, thread, command) {
    const works = await deps.works.listByProject(thread.projectId, {
      lifecycle: command.archived ? "archived" : "active",
    });
    return works.map(modelWork);
  },
  async create(deps, thread, command) {
    const work = await createWork(
      { works: deps.works },
      {
        projectId: thread.projectId,
        createdByUserId: thread.userId,
        name: command.name,
        goal: command.goal,
      },
    );
    return {
      output: modelWork(work),
      metadata: {
        workReceipt: {
          operation: "create",
          category: "mutate",
          changed: true,
          workId: work.id,
          workName: work.name,
          before: null,
          after: receiptState(work),
          inverse: { command: "delete", workId: work.id },
        } satisfies WorkReceipt,
      },
    };
  },
  show: onSelectedWork(async (deps, thread, work) => {
    const [threads, drafts] = await Promise.all([
      deps.threads.listRecentByWork(thread.projectId, work.id, 10),
      deps.drafts.draftReview.list({ projectId: thread.projectId, workId: work.id }),
    ]);
    return {
      work: modelWork(work),
      recentThreads: threads.map(({ title, updatedAt, status }) => ({ title, updatedAt, status })),
      drafts: drafts.map(({ workId: _workId, ...draft }) => draft),
    };
  }),
  update: onSelectedWork(async (deps, thread, work, command) =>
    updateReceipt(
      await updateWorkTransition(
        { works: deps.works, workContextNotices: deps.workContextNotices },
        work.id,
        { name: command.name, goal: command.goal, status: command.status },
        { originThreadId: thread.id },
      ),
    ),
  ),
  archive: archiving(true),
  unarchive: archiving(false),
  delete: onSelectedWork(async (deps, _thread, work) => {
    const transition = await deleteWorkTransition(
      { works: deps.works, stopThreadRun: deps.stopThreadRun },
      work.id,
    );
    const before = transition.before ?? work;
    return {
      output: modelWork(transition.after ?? before),
      metadata: {
        workReceipt: {
          operation: "delete",
          category: "mutate",
          changed: transition.changed,
          workId: before.id,
          workName: before.name,
          before: receiptState(before),
          after: null,
          inverse: transition.changed ? { command: "restore", workId: before.id } : null,
        } satisfies WorkReceipt,
      },
    };
  }),
};

export function createWorkHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const command = input as WorkCommand;
    const thread = await deps.threads.findById(ctx.threadId);
    if (!thread) return toolError({ message: `Thread not found: ${ctx.threadId}` });

    if (command.command === "switch") {
      // A switch that couldn't happen says why before the policy asks for approval (D37).
      const target = await resolveSwitchTarget(
        deps,
        thread.projectId,
        thread.id as ThreadId,
        command.work,
      );
      if ("isError" in target) return target;
      if ("unchanged" in target) return target.unchanged;
      // The model's switch is `ask` until the writer prompt lands (#601).
      return policyRefusal(command, "ask");
    }

    const permission = await deps.readChainPermission(thread.id as ThreadId);
    const decision = actionPolicy(permission, `work.${command.command}`);
    if (decision !== "allow") return policyRefusal(command, decision);
    try {
      const run = COMMANDS[command.command] as CommandHandler<CommandName>;
      return await run(deps, thread, command as CommandOf<CommandName>);
    } catch (error) {
      if (error instanceof WorkStatusInvalidError) {
        return toolError({ code: "invalid_work_status", message: error.message });
      }
      if (error instanceof WorkNameRequiredError) {
        return toolError({ code: "invalid_work_name", message: error.message });
      }
      if (error instanceof WorkLifecycleUnavailableError) {
        return toolError({
          code: error.state === "archived" ? "work_archived" : "work_not_found",
          message: workLifecycleMessage(
            `work_${error.state}`,
            "work" in command && command.work ? command.work : (error.workSlug ?? null),
            mayChangeWorks(permission),
          ),
        });
      }
      return toolError({ message: error instanceof Error ? error.message : String(error) });
    }
  };
}
