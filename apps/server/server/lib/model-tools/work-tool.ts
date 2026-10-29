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
import type { PermissionExecutor } from "../../domains/runtime/asks/ask-service.js";
import {
  type AskableAction,
  actionPolicy,
  handlerToolResult,
  type ModelWork,
  mayChangeWorks,
  type RequestToolHandlerContext,
  type ToolRegistry,
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
async function resolveSwitch(
  deps: ToolWiringDeps,
  thread: Thread,
  handle: string | null | undefined,
): Promise<Resolution> {
  let work: Work;
  if (handle) {
    const found = await workByHandle(deps, thread.projectId, handle);
    if (isToolError(found)) return { ok: false, result: found };
    if (workLifecycleState(found) === "deleted") {
      return {
        ok: false,
        result: toolError({
          code: "work_not_found",
          message: await deps.contextPorts.chatFiles.unknownWork(thread.projectId, handle),
          workHandle: handle,
        }),
      };
    }
    work = found;
  } else {
    const noWork = await deps.works.findNoWork(thread.projectId);
    if (!noWork)
      return { ok: false, result: toolError({ message: "No Work is missing for this project" }) };
    work = noWork;
  }
  const named = work.handle ?? "No Work";
  if (workLifecycleState(work) === "archived") {
    return {
      ok: false,
      result: toolError({
        code: "work_archived",
        message: `Work ${named} is archived. Ask the user to unarchive it before switching.`,
      }),
    };
  }
  const current = await deps.threadWorks.findPrimary(thread.id as ThreadId);
  const currentId = current?.workId ?? (work.isNoWork ? work.id : null);
  if (currentId === work.id)
    return { ok: false, result: { message: `This chat is already in ${named}.` } };
  return { ok: true, command: { command: "switch", work } };
}

/**
 * The model's command with its target resolved, before policy, so the model gets the
 * useful target error rather than an unrelated permission refusal. `result` is the
 * call's whole answer: a tool error, or a switch's no-op message.
 */
async function resolveWorkCommand(
  deps: ToolWiringDeps,
  thread: Thread,
  command: WorkCommand,
): Promise<Resolution> {
  switch (command.command) {
    case "list":
    case "create":
    case "write_mode":
      return { ok: true, command };
    case "switch":
      return resolveSwitch(deps, thread, command.work);
    default: {
      const work = await workByHandle(deps, thread.projectId, command.work);
      return isToolError(work)
        ? { ok: false, result: work }
        : { ok: true, command: { ...command, work } };
    }
  }
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

type Resolution =
  | { ok: true; command: ResolvedWorkCommand }
  | { ok: false; result: ToolErrorOutput | { message: string } };

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
function permissionCommand(command: AskedWorkCommand): PermissionWorkCommand {
  if (!("work" in command)) return command;
  const { work, ...fields } = command;
  return { ...fields, workId: work.id };
}

/** The command an Allow stored, its target loaded again by id. */
async function resolveStored(
  deps: ToolWiringDeps,
  thread: Thread,
  stored: PermissionWorkCommand,
): Promise<Resolution> {
  if (!("workId" in stored)) return { ok: true, command: stored };
  const { workId, ...fields } = stored;
  const work = await deps.works.findById(workId);
  if (!work || work.projectId !== thread.projectId)
    return {
      ok: false,
      result: toolError({
        code: "work_not_found",
        message: "The approved Work is no longer available.",
      }),
    };
  return { ok: true, command: { ...fields, work } };
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
 * Runs what the writer allowed, in a savepoint inside the answer's transaction: a domain
 * refusal rolls back its writes and after-commit effects first, then becomes the result, so
 * the answer still commits. Any other failure propagates and rolls back the answer. The
 * result is shaped as the `work` call's own would be.
 */
export function createAllowedWorkExecutor(
  deps: ToolWiringDeps & { savepoint<T>(operation: () => Promise<T>): Promise<T> },
  registry: Pick<ToolRegistry, "getRegistration">,
): PermissionExecutor {
  async function run(thread: Thread, command: PermissionWorkCommand): Promise<unknown> {
    const resolution = await resolveStored(deps, thread, command);
    if (!resolution.ok) return resolution.result;
    try {
      return await deps.savepoint(() => executeWorkCommand(deps, thread, resolution.command));
    } catch (error) {
      const expected = expectedWorkError(error, undefined, true);
      if (!expected) throw error;
      return expected;
    }
  }

  return {
    async execute({ threadId, command, always }) {
      const registration = registry.getRegistration("work");
      if (!registration) throw new Error("The work tool is not registered");
      // The answer found the chat under its lock; a delete in between cancels the ask instead.
      const thread = await deps.threads.findById(threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      const output = await run(thread, command);
      if (always)
        await deps.permissionGrants.grant(thread.projectId as ProjectId, `work.${command.command}`);
      const shaped = handlerToolResult(output, registration, { command: command.command });
      return {
        output: shaped.output,
        result: shaped.result,
        isError: shaped.isError === true,
        ...(shaped.metadata ? { metadata: shaped.metadata } : {}),
      };
    },
  };
}

export function createWorkHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: RequestToolHandlerContext) => {
    const command = input as WorkCommand;
    const thread = await deps.threads.findById(ctx.threadId);
    if (!thread) return toolError({ message: `Thread not found: ${ctx.threadId}` });

    const resolution = await resolveWorkCommand(deps, thread, command);
    if (!resolution.ok) return resolution.result;
    const resolved = resolution.command;

    const permission = await deps.readChainPermission(thread.id as ThreadId);
    const decision = actionPolicy(permission, `work.${resolved.command}`);
    if (decision === "deny")
      return policyRefusal(
        "This agent can read but can't change Works. Ask the user to make this change.",
      );
    if (decision === "ask") {
      // The policy table's type forbids `ask` for any other action; this keeps it from
      // becoming a silent allow if that ever slips.
      if (!isAskable(resolved))
        throw new Error(`The action policy asks about work.${resolved.command}, which can't ask`);
      // A grant is the writer's own standing answer, so it holds for subagents too.
      const action = `work.${resolved.command}` as const;
      if (!(await deps.permissionGrants.has(thread.projectId as ProjectId, action))) {
        if (thread.kind === "subagent")
          return policyRefusal(
            "Only the main chat can ask the writer to allow this change. If your task needs it, stop and say in your report what is missing.",
          );
        const outcome = await ctx.request({
          kind: "permission",
          payload: permissionPayload(thread, resolved),
          command: permissionCommand(resolved),
        });
        return outcome.kind === "refused" ? { isError: true, output: outcome.refusal } : outcome;
      }
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
