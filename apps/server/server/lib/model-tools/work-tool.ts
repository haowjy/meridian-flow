/**
 * The model `work` tool: list, show and change the project's Works. The action
 * policy decides each command (D39). Work rebinding and queued write-mode
 * changes run under the calling execution's existing claim.
 */
import { type PermissionDeniedReason, TOOL_EXCEPTION_CODE } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import type {
  PermissionAskPayload,
  PermissionWorkCommand,
  Thread,
} from "@meridian/contracts/threads";
import type { Work, WorkReceipt, WorkReceiptState } from "@meridian/contracts/works";
import { workLifecycleState } from "@meridian/contracts/works";
import {
  createWork,
  deleteWorkTransition,
  setWorkArchived,
  updateWorkTransition,
  WorkLifecycleUnavailableError,
  WorkLockedError,
  WorkNameConflictError,
  WorkNameRequiredError,
  WorkStatusInvalidError,
} from "../../domains/projects/index.js";
import {
  type AgentAction,
  actionPolicy,
  type ModelWork,
  mayChangeWorks,
  type RequestToolHandlerContext,
  type WorkCommand,
  type WorkShowResult,
} from "../../domains/runtime/index.js";
import { renderWorkResult } from "../../domains/runtime/tools/work-result.js";
import { RebindThreadWorkError, switchThreadWork } from "../../domains/threads/index.js";
import {
  isToolError,
  type ToolErrorOutput,
  type ToolWiringDeps,
  toolError,
} from "./tool-context.js";

/**
 * A Work as the handler returns it; `renderWorkResult` decides what the model
 * reads. Pending changes use the writer's words. A Work has no write mode of
 * its own: the chat's mode is in its work context (D62).
 */
function modelWork(work: Work): ModelWork {
  const {
    handle,
    name,
    goal,
    status,
    archivedAt,
    createdAt,
    updatedAt,
    lastActivityAt,
    pendingDocumentCount,
  } = work;
  return {
    handle,
    name,
    goal,
    status,
    archivedAt,
    createdAt,
    updatedAt,
    lastActivityAt,
    pendingDocumentCount,
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

/** A Work by the handle the model copied. A name gets the handle that answers it, never a match. */
async function workByHandle(
  deps: ToolWiringDeps,
  projectId: string,
  ref: string,
): Promise<Work | ToolErrorOutput> {
  const reference = await deps.contextPorts.chatFiles.workReference(projectId, ref);
  const work = reference.ok
    ? await deps.works.findByHandle(projectId, reference.work.handle)
    : null;
  if (work) return work;
  return toolError({
    code: "work_not_found",
    message: reference.ok
      ? await deps.contextPorts.chatFiles.unknownWork(projectId, ref)
      : reference.message,
    workHandle: ref,
  });
}

/**
 * Why a `switch` can't happen, or null when it can proceed.
 * An unknown Work points to `work list` (D51), an archived one can't be
 * switched to by anyone, and the chat's current Work needs no switch.
 */
async function switchPrecheck(
  deps: ToolWiringDeps,
  projectId: string,
  threadId: ThreadId,
  handle: string | null | undefined,
): Promise<{ message: string } | ToolErrorOutput | null> {
  let work: Work;
  if (handle) {
    const found = await workByHandle(deps, projectId, handle);
    if (isToolError(found)) return found;
    if (workLifecycleState(found) === "deleted") {
      return toolError({
        code: "work_not_found",
        message: await deps.contextPorts.chatFiles.unknownWork(projectId, handle),
        workHandle: handle,
      });
    }
    work = found;
  } else {
    const noWork = await deps.works.findNoWork(projectId);
    if (!noWork) return toolError({ message: "No Work is missing for this project" });
    work = noWork;
  }
  const named = work.handle ?? "No Work";
  if (workLifecycleState(work) === "archived") {
    return toolError({
      code: "work_archived",
      message: `Work ${named} is archived. Ask the user to unarchive it before switching.`,
    });
  }
  const current = await deps.threadWorks.findPrimary(threadId);
  const currentId = current?.workId ?? (work.isNoWork ? work.id : null);
  if (currentId === work.id) return { message: `This chat is already in ${named}.` };
  return null;
}

/**
 * A `work` command on an archived or gone Work. Offers the unarchive call only
 * when the action policy would allow it.
 */
function workLifecycleMessage(
  reason: "work_archived" | "work_deleted" | "work_missing",
  workHandle: string | null,
  mayUnarchive: boolean,
): string {
  if (reason !== "work_archived") {
    return workHandle ? `Work ${workHandle} is unavailable.` : "The requested Work is unavailable.";
  }
  if (!workHandle) return "The requested Work is archived and read-only.";
  return mayUnarchive
    ? `Work ${workHandle} is archived. To change it, use \`work({"command":"unarchive","work":"${workHandle}"})\`.`
    : `Work ${workHandle} is archived and read-only. Ask the user to unarchive ${workHandle}.`;
}

function policyRefusal(message: string): ToolErrorOutput {
  return toolError({
    code: "permission_denied",
    reason: "action_denied" satisfies PermissionDeniedReason,
    message,
  });
}

/** A `work` command that changes something, the only kind the policy can ask about. */
type AskedWorkCommand = Exclude<WorkCommand, { command: "list" | "show" }>;

/**
 * What the writer is asked to allow: the action, its target as named now, and what it
 * sets. The client renders the sentence.
 */
function permissionPayload(
  thread: Thread,
  command: AskedWorkCommand,
  target: Work | null,
): PermissionAskPayload {
  const { command: verb, ...fields } = command;
  const changes =
    verb === "create" || verb === "update" || verb === "write_mode"
      ? Object.fromEntries(
          Object.entries(fields).filter(([key, value]) => key !== "work" && value !== undefined),
        )
      : {};
  return {
    agent: thread.agentName?.trim() || null,
    action: `work.${verb}`,
    work: target ? { handle: target.handle, name: target.name } : null,
    changes,
  };
}

/** The command an Allow runs: its target pinned by id, so a later rename can't retarget it. */
function permissionCommand(
  thread: Thread,
  command: AskedWorkCommand,
  target: Work | null,
): PermissionWorkCommand {
  const projectId = thread.projectId;
  if (command.command === "create")
    return {
      tool: "work",
      projectId,
      command: { command: "create", name: command.name, goal: command.goal },
    };
  if (command.command === "write_mode")
    return { tool: "work", projectId, command: { command: "write_mode", mode: command.mode } };
  if (!target) throw new Error(`work.${command.command} asked with no resolved target`);
  if (command.command === "update")
    return {
      tool: "work",
      projectId,
      command: {
        command: "update",
        workId: target.id,
        name: command.name,
        goal: command.goal,
        status: command.status,
      },
    };
  return { tool: "work", projectId, command: { command: command.command, workId: target.id } };
}

/**
 * Every expected refusal the Work writer commands raise, as the model's tool
 * error. Anything else is an infrastructure failure and propagates.
 */
function expectedWorkError(
  error: unknown,
  workHandle: string | undefined,
  mayUnarchive: boolean,
): ToolErrorOutput | null {
  if (error instanceof WorkStatusInvalidError)
    return toolError({ code: "invalid_work_status", message: error.message });
  if (error instanceof WorkNameRequiredError)
    return toolError({ code: "invalid_work_name", message: error.message });
  if (error instanceof WorkNameConflictError)
    return toolError({ code: "work_name_conflict", message: error.message });
  if (error instanceof WorkLockedError)
    return toolError({ code: error.code, message: error.message });
  if (error instanceof WorkLifecycleUnavailableError)
    return toolError({
      code: error.state === "archived" ? "work_archived" : "work_not_found",
      message: workLifecycleMessage(
        `work_${error.state}`,
        workHandle ?? error.workHandle,
        mayUnarchive,
      ),
    });
  if (error instanceof RebindThreadWorkError)
    return toolError({
      code: error.code === "target_work_unavailable" ? "work_archived" : "work_not_found",
      message:
        error.code === "target_work_unavailable"
          ? 'That Work is no longer available. Use `work({"command":"list"})` and choose another.'
          : "This chat or Work is no longer available.",
    });
  return null;
}

/** Runs the approved command as the chat's writer. Domain refusals throw. */
async function runPermissionWorkCommand(
  deps: ToolWiringDeps,
  input: { threadId: ThreadId; command: PermissionWorkCommand },
): Promise<unknown> {
  const stored = input.command;
  const thread = await deps.threads.findById(input.threadId);
  const project = await deps.projects.findById(stored.projectId);
  if (
    !thread ||
    !project ||
    project.deletedAt ||
    project.userId !== thread.userId ||
    thread.projectId !== stored.projectId
  )
    return toolError({
      code: "work_not_found",
      message: "This chat or project is no longer available.",
    });
  const userId = thread.userId as UserId;
  const command = stored.command;
  if (command.command === "create") {
    const work = await createWork(
      { works: deps.works },
      {
        projectId: stored.projectId,
        createdByUserId: userId,
        name: command.name,
        goal: command.goal,
      },
    );
    return {
      output: modelWork(work),
      metadata: {
        workReceipt: {
          operation: "create",
          changed: true,
          workId: work.id,
          workName: work.name,
          before: null,
          after: receiptState(work),
          inverse: { command: "delete", workId: work.id },
        } satisfies WorkReceipt,
      },
    };
  }
  if (command.command === "write_mode") {
    await deps.controls.enqueueControl({
      threadId: input.threadId,
      id: crypto.randomUUID(),
      provenance: { kind: "writer", actorId: userId },
      control: { kind: "write_mode", mode: command.mode },
    });
    return { mode: command.mode, applies: "next_reply" };
  }
  const workId = command.workId;
  const work = await deps.works.findById(workId);
  if (!work || work.projectId !== stored.projectId)
    return toolError({
      code: "work_not_found",
      message: "The approved Work is no longer available.",
    });
  if (command.command === "switch") {
    const rebound = await switchThreadWork(deps, { threadId: input.threadId, workId });
    return { handle: rebound.after.handle, name: rebound.after.name };
  }
  if (command.command === "update")
    return updateReceipt(
      await updateWorkTransition(
        { works: deps.works, workContextNotices: deps.workContextNotices },
        workId,
        { name: command.name, goal: command.goal, status: command.status },
        { originThreadId: input.threadId },
      ),
    );
  if (command.command === "archive" || command.command === "unarchive")
    return updateReceipt(
      await setWorkArchived(
        { works: deps.works, workContextNotices: deps.workContextNotices },
        workId,
        command.command === "archive",
        { originThreadId: input.threadId },
      ),
    );
  const transition = await deleteWorkTransition(
    { works: deps.works, stopThreads: deps.stopThreads },
    workId,
  );
  const before = transition.before ?? work;
  return {
    output: modelWork(transition.after ?? before),
    metadata: {
      workReceipt: {
        operation: "delete",
        changed: transition.changed,
        workId: before.id,
        workName: before.name,
        before: receiptState(before),
        after: null,
        inverse: transition.changed ? { command: "restore", workId: before.id } : null,
      } satisfies WorkReceipt,
    },
  };
}

/**
 * Before the answer locks its ask: a delete ends the Work's threads while the answer holds
 * the asking chat's locks, so it takes the tree's lineage locks and the asking chat's
 * together, in the order a concurrent delete takes them.
 */
export async function lockAheadOfPermissionWorkCommand(
  deps: Pick<ToolWiringDeps, "works" | "lockThreads">,
  input: { threadId: ThreadId; command: PermissionWorkCommand },
): Promise<void> {
  const { command } = input.command;
  if (command.command !== "delete") return;
  await deps.lockThreads([input.threadId, ...(await deps.works.listThreadTree(command.workId))]);
}

/**
 * The approved action's tool result. The action runs in a savepoint inside the
 * caller's answer transaction: a domain refusal rolls back its writes and
 * after-commit effects first, then becomes the tool result, so the answer
 * still commits. Any other failure propagates and rolls back the answer.
 */
export async function permissionWorkToolResult(
  deps: ToolWiringDeps & { savepoint<T>(operation: () => Promise<T>): Promise<T> },
  input: { threadId: ThreadId; command: PermissionWorkCommand },
) {
  let executed: unknown;
  try {
    executed = await deps.savepoint(() => runPermissionWorkCommand(deps, input));
  } catch (error) {
    executed = expectedWorkError(error, undefined, true);
    if (!executed) throw error;
  }
  const structured =
    typeof executed === "object" && executed !== null && "output" in executed
      ? (executed as { output: unknown; metadata?: Record<string, unknown>; isError?: boolean })
      : null;
  const result = JSON.parse(JSON.stringify(structured ? structured.output : executed));
  return {
    result,
    output: renderWorkResult(result, input.command.command as never),
    isError: structured?.isError === true,
    ...(structured?.metadata ? { metadata: structured.metadata as never } : {}),
  };
}

type CommandName = Exclude<WorkCommand["command"], "switch" | "write_mode">;
type CommandOf<C extends CommandName> = Extract<WorkCommand, { command: C }>;
type CommandHandler<C extends CommandName> = (
  deps: ToolWiringDeps,
  thread: Thread,
  command: CommandOf<C>,
) => Promise<unknown>;

/** A command on one named Work: an unknown handle points to `work list` (D51). */
function onSelectedWork<C extends Exclude<CommandName, "list" | "create">>(
  run: (
    deps: ToolWiringDeps,
    thread: Thread,
    work: Work,
    command: CommandOf<C>,
  ) => Promise<unknown>,
): CommandHandler<C> {
  return async (deps, thread, command) => {
    const { work: handle } = command as unknown as { work: string };
    const selected = await workByHandle(deps, thread.projectId, handle);
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
      deps.branches.draftReview.list({ projectId: thread.projectId, workId: work.id }),
    ]);
    return {
      work: modelWork(work),
      recentThreads: threads.map(({ title, updatedAt, status }) => ({ title, updatedAt, status })),
      drafts,
    } satisfies WorkShowResult;
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
      { works: deps.works, stopThreads: deps.stopThreads },
      work.id,
    );
    const before = transition.before ?? work;
    return {
      output: modelWork(transition.after ?? before),
      metadata: {
        workReceipt: {
          operation: "delete",
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
  return async (input: unknown, ctx: RequestToolHandlerContext) => {
    const command = input as WorkCommand;
    const thread = await deps.threads.findById(ctx.threadId);
    if (!thread) return toolError({ message: `Thread not found: ${ctx.threadId}` });

    let resolvedTarget: Work | null = null;
    if (command.command === "switch") {
      if (command.work) {
        const selected = await workByHandle(deps, thread.projectId, command.work);
        if (isToolError(selected)) return selected;
        resolvedTarget = selected;
      } else {
        resolvedTarget = await deps.works.findNoWork(thread.projectId);
        if (!resolvedTarget) return toolError({ message: "No Work is missing for this project" });
      }
      // Resolve lifecycle and no-op outcomes before policy, so the model gets the
      // useful target error rather than an unrelated permission refusal.
      const precheck = await switchPrecheck(
        deps,
        thread.projectId,
        thread.id as ThreadId,
        command.work,
      );
      if (precheck) return precheck;
    }

    const permission = await deps.readChainPermission(thread.id as ThreadId);
    const action: AgentAction = `work.${command.command}`;
    const baseDecision = actionPolicy(permission, action);
    if (baseDecision === "deny")
      return policyRefusal(
        "This agent can read but can't change Works. Ask the user to make this change.",
      );
    // Only the main chat reaches the writer; a grant never lifts a child.
    if (baseDecision === "ask" && thread.kind === "subagent")
      return policyRefusal(
        "Only the main chat can ask the writer to allow this change. If your task needs it, stop and say in your report what is missing.",
      );
    if (
      baseDecision === "ask" &&
      command.command !== "list" &&
      command.command !== "show" &&
      !(await deps.permissionGrants.has(thread.projectId as ProjectId, action))
    ) {
      if ("work" in command && command.work && !resolvedTarget) {
        const selected = await workByHandle(deps, thread.projectId, command.work);
        if (isToolError(selected)) return selected;
        resolvedTarget = selected;
      }
      const outcome = await ctx.request({
        kind: "permission",
        payload: permissionPayload(thread, command, resolvedTarget),
        command: permissionCommand(thread, command, resolvedTarget),
      });
      return outcome.kind === "refused" ? { isError: true, output: outcome.refusal } : outcome;
    }
    try {
      if (command.command === "switch") {
        const target = command.work
          ? await workByHandle(deps, thread.projectId, command.work)
          : await deps.works.findNoWork(thread.projectId);
        if (!target) return toolError({ message: "No Work is missing for this project" });
        if (isToolError(target)) return target;
        const rebound = await deps.transaction(() =>
          switchThreadWork(deps, {
            threadId: thread.id as ThreadId,
            workId: target.id,
          }),
        );
        return { handle: rebound.after.handle, name: rebound.after.name };
      }
      if (command.command === "write_mode") {
        await deps.controls.enqueueControl({
          threadId: thread.id as ThreadId,
          id: crypto.randomUUID(),
          provenance: { kind: "agent", threadId: thread.id },
          control: { kind: "write_mode", mode: command.mode },
        });
        return { mode: command.mode, applies: "next_reply" };
      }
      const run = COMMANDS[command.command] as CommandHandler<CommandName>;
      return await run(deps, thread, command as CommandOf<CommandName>);
    } catch (error) {
      const expected = expectedWorkError(
        error,
        "work" in command && command.work ? command.work : undefined,
        mayChangeWorks(permission),
      );
      if (expected) return expected;
      return toolError({
        code: TOOL_EXCEPTION_CODE,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
