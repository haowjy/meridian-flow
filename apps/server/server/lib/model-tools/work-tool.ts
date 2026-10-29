/**
 * The model `work` tool: list, show and change the project's Works. The action
 * policy decides each command (D39). Work rebinding and queued write-mode
 * changes run under the calling execution's existing claim.
 */
import { type PermissionDeniedReason, TOOL_EXCEPTION_CODE } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import {
  type PermissionAskPayload,
  type PermissionWorkCommand,
  permissionActionSchema,
  type Thread,
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
  type AskableAction,
  actionPolicy,
  type ModelWork,
  mayChangeWorks,
  type RequestToolHandlerContext,
  type WorkCommand,
  type WorkShowResult,
} from "../../domains/runtime/index.js";
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
 * A `switch`'s target, or why it can't happen. An unknown Work points to `work list` (D51),
 * an archived one can't be switched to by anyone, and the chat's current Work needs no switch.
 */
async function switchTarget(
  deps: ToolWiringDeps,
  thread: Thread,
  handle: string | null | undefined,
): Promise<Work | { message: string } | ToolErrorOutput> {
  let work: Work;
  if (handle) {
    const found = await workByHandle(deps, thread.projectId, handle);
    if (isToolError(found)) return found;
    if (workLifecycleState(found) === "deleted") {
      return toolError({
        code: "work_not_found",
        message: await deps.contextPorts.chatFiles.unknownWork(thread.projectId, handle),
        workHandle: handle,
      });
    }
    work = found;
  } else {
    const noWork = await deps.works.findNoWork(thread.projectId);
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
  const current = await deps.threadWorks.findPrimary(thread.id as ThreadId);
  const currentId = current?.workId ?? (work.isNoWork ? work.id : null);
  if (currentId === work.id) return { message: `This chat is already in ${named}.` };
  return work;
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

/**
 * A `work` command with its target resolved to a Work: from the handle the model gave, or
 * from the id an Allow stored. `switch` to No Work resolves to the project's No Work.
 */
type ResolvedWorkCommand =
  | Extract<WorkCommand, { command: "list" | "create" | "write_mode" }>
  | (Omit<Extract<WorkCommand, { command: "show" }>, "work"> & { work: Work })
  | (Omit<Extract<WorkCommand, { command: "update" }>, "work"> & { work: Work })
  | { [C in "archive" | "unarchive" | "delete" | "switch"]: { command: C; work: Work } }[
      | "archive"
      | "unarchive"
      | "delete"
      | "switch"];

type AskableCommand = AskableAction extends `work.${infer C}` ? C : never;
type AskedWorkCommand = Extract<ResolvedWorkCommand, { command: AskableCommand }>;

const ASKABLE: ReadonlySet<string> = new Set(permissionActionSchema.options);

function isAskable(command: ResolvedWorkCommand): command is AskedWorkCommand {
  return ASKABLE.has(`work.${command.command}`);
}

/**
 * What the writer is asked to allow: the action, its target as named now, and what it
 * sets. The client renders the sentence.
 */
function permissionPayload(thread: Thread, command: AskedWorkCommand): PermissionAskPayload {
  const { command: verb, ...fields } = command;
  const changes =
    verb === "create" || verb === "update" || verb === "write_mode"
      ? Object.fromEntries(
          Object.entries(fields).filter(([key, value]) => key !== "work" && value !== undefined),
        )
      : {};
  const agent = thread.agentName?.trim() || null;
  if ("work" in command) {
    const { handle, name } = command.work;
    return { agent, action: `work.${command.command}`, work: { handle, name }, changes };
  }
  return { agent, action: `work.${command.command}`, work: null, changes };
}

/** The command an Allow runs: its target pinned by id, so a later rename can't retarget it. */
function permissionCommand(thread: Thread, command: AskedWorkCommand): PermissionWorkCommand {
  const projectId = thread.projectId;
  switch (command.command) {
    case "create":
      return {
        tool: "work",
        projectId,
        command: { command: "create", name: command.name, goal: command.goal },
      };
    case "write_mode":
      return { tool: "work", projectId, command: { command: "write_mode", mode: command.mode } };
    case "update":
      return {
        tool: "work",
        projectId,
        command: {
          command: "update",
          workId: command.work.id,
          name: command.name,
          goal: command.goal,
          status: command.status,
        },
      };
    default:
      return {
        tool: "work",
        projectId,
        command: { command: command.command, workId: command.work.id },
      };
  }
}

/** The command an Allow stored, its target loaded again by id. */
async function resolveStored(
  deps: ToolWiringDeps,
  stored: PermissionWorkCommand,
): Promise<ResolvedWorkCommand | ToolErrorOutput> {
  const { command } = stored;
  if (command.command === "create" || command.command === "write_mode") return command;
  const work = await deps.works.findById(command.workId);
  if (!work || work.projectId !== stored.projectId)
    return toolError({
      code: "work_not_found",
      message: "The approved Work is no longer available.",
    });
  const { workId: _, ...fields } = command;
  return { ...fields, work };
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

type CommandName = ResolvedWorkCommand["command"];
type CommandOf<C extends CommandName> = Extract<ResolvedWorkCommand, { command: C }>;
type CommandHandler<C extends CommandName> = (
  deps: ToolWiringDeps,
  thread: Thread,
  command: CommandOf<C>,
) => Promise<unknown>;

async function archiving(deps: ToolWiringDeps, thread: Thread, work: Work, archived: boolean) {
  return updateReceipt(
    await setWorkArchived(
      { works: deps.works, workContextNotices: deps.workContextNotices },
      work.id,
      archived,
      { originThreadId: thread.id },
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
  async show(deps, thread, { work }) {
    const [threads, drafts] = await Promise.all([
      deps.threads.listRecentByWork(thread.projectId, work.id, 10),
      deps.branches.draftReview.list({ projectId: thread.projectId, workId: work.id }),
    ]);
    return {
      work: modelWork(work),
      recentThreads: threads.map(({ title, updatedAt, status }) => ({ title, updatedAt, status })),
      drafts,
    } satisfies WorkShowResult;
  },
  async update(deps, thread, command) {
    return updateReceipt(
      await updateWorkTransition(
        { works: deps.works, workContextNotices: deps.workContextNotices },
        command.work.id,
        { name: command.name, goal: command.goal, status: command.status },
        { originThreadId: thread.id },
      ),
    );
  },
  archive: (deps, thread, { work }) => archiving(deps, thread, work, true),
  unarchive: (deps, thread, { work }) => archiving(deps, thread, work, false),
  async delete(deps, _thread, { work }) {
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
  },
  async switch(deps, thread, { work }) {
    // Joins the answer's transaction under an Allow.
    const rebound = await deps.transaction(() =>
      switchThreadWork(deps, { threadId: thread.id as ThreadId, workId: work.id }),
    );
    return { handle: rebound.after.handle, name: rebound.after.name };
  },
  async write_mode(deps, thread, { mode }) {
    // Agent provenance under an Allow too: the writer allowed this chat's switch, not a new
    // default for the Work. The ask's receipt records the Allow.
    await deps.controls.enqueueControl({
      threadId: thread.id as ThreadId,
      id: crypto.randomUUID(),
      provenance: { kind: "agent", threadId: thread.id },
      control: { kind: "write_mode", mode },
    });
    return { mode, applies: "next_reply" };
  },
};

/**
 * Runs a resolved `work` command, for the model's own call and for the writer's Allow alike.
 * Returns the handler result the tool executor shapes; expected domain refusals throw, for
 * the caller to translate with `expectedWorkError`.
 */
function executeWorkCommand(
  deps: ToolWiringDeps,
  thread: Thread,
  command: ResolvedWorkCommand,
): Promise<unknown> {
  const run = COMMANDS[command.command] as CommandHandler<CommandName>;
  return run(deps, thread, command as CommandOf<CommandName>);
}

/**
 * Runs what the writer allowed in a savepoint inside the answer's
 * transaction: a domain refusal rolls back its writes and after-commit effects first, then
 * becomes the result, so the answer still commits. Any other failure propagates and rolls
 * back the answer. Returns a handler result, as the `work` tool's handler does.
 */
export async function runAllowedWorkCommand(
  deps: ToolWiringDeps & { savepoint<T>(operation: () => Promise<T>): Promise<T> },
  input: { threadId: ThreadId; command: PermissionWorkCommand },
): Promise<unknown> {
  const thread = await deps.threads.findById(input.threadId);
  const project = await deps.projects.findById(input.command.projectId);
  if (
    !thread ||
    !project ||
    project.deletedAt ||
    project.userId !== thread.userId ||
    thread.projectId !== input.command.projectId
  )
    return toolError({
      code: "work_not_found",
      message: "This chat or project is no longer available.",
    });
  const resolved = await resolveStored(deps, input.command);
  if (isToolError(resolved)) return resolved;
  try {
    return await deps.savepoint(() => executeWorkCommand(deps, thread, resolved));
  } catch (error) {
    const expected = expectedWorkError(error, undefined, true);
    if (!expected) throw error;
    return expected;
  }
}

/** The model's command with its handle resolved; an unknown handle points to `work list` (D51). */
async function resolveWorkCommand(
  deps: ToolWiringDeps,
  thread: Thread,
  command: Exclude<WorkCommand, { command: "switch" }>,
): Promise<ResolvedWorkCommand | ToolErrorOutput> {
  if (
    command.command === "list" ||
    command.command === "create" ||
    command.command === "write_mode"
  )
    return command;
  const work = await workByHandle(deps, thread.projectId, command.work);
  return isToolError(work) ? work : { ...command, work };
}

export function createWorkHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: RequestToolHandlerContext) => {
    const command = input as WorkCommand;
    const thread = await deps.threads.findById(ctx.threadId);
    if (!thread) return toolError({ message: `Thread not found: ${ctx.threadId}` });

    // A switch's lifecycle and no-op outcomes come before policy, so the model gets the
    // useful target error rather than an unrelated permission refusal.
    let switched: Work | undefined;
    if (command.command === "switch") {
      const target = await switchTarget(deps, thread, command.work);
      if (isToolError(target) || !("id" in target)) return target;
      switched = target;
    }

    const permission = await deps.readChainPermission(thread.id as ThreadId);
    const decision = actionPolicy(permission, `work.${command.command}`);
    if (decision === "deny")
      return policyRefusal(
        "This agent can read but can't change Works. Ask the user to make this change.",
      );
    const resolved =
      command.command === "switch" && switched
        ? { command: "switch" as const, work: switched }
        : await resolveWorkCommand(
            deps,
            thread,
            command as Exclude<WorkCommand, { command: "switch" }>,
          );
    if (isToolError(resolved)) return resolved;

    // A grant is the writer's own standing answer, so it holds for subagents too.
    if (
      decision === "ask" &&
      isAskable(resolved) &&
      !(await deps.permissionGrants.has(thread.projectId as ProjectId, `work.${resolved.command}`))
    ) {
      if (thread.kind === "subagent")
        return policyRefusal(
          "Only the main chat can ask the writer to allow this change. If your task needs it, stop and say in your report what is missing.",
        );
      const outcome = await ctx.request({
        kind: "permission",
        payload: permissionPayload(thread, resolved),
        command: permissionCommand(thread, resolved),
      });
      return outcome.kind === "refused" ? { isError: true, output: outcome.refusal } : outcome;
    }
    try {
      return await executeWorkCommand(deps, thread, resolved);
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
