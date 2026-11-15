/**
 * The check on an AI write into an Agents level, shared by the document writes and the tree
 * commands: what the grant learned (`AgentsCheckTarget`), the check once the write has landed,
 * and the receipt line it adds.
 */
import { randomUUID } from "node:crypto";
import type { AgentsLevel } from "@meridian/contracts/agents";
import { contextPortForThread } from "../../domains/context/index.js";
import type { ModelEditHandlerResult, ToolHandlerContext } from "../../domains/runtime/index.js";
import type { AgentsCheck } from "../agents-widening.js";
import type { ResolvedModelContextPort, ToolCall, ToolWiringDeps } from "./tool-context.js";

/**
 * What a write to an Agents level learned while it was granted: the check runs once it lands.
 * A move between a project's Agents and the account's touches two levels; the server Applies only
 * when every grant says it may.
 */
export type AgentsCheckTarget = { levels?: AgentsLevel[]; apply?: boolean };

/** Notes that the write touches `level`, whose place says whether the server may Apply it. */
export function markAgentsWrite(checked: AgentsCheckTarget, level: AgentsLevel, applies: boolean) {
  checked.levels = [...new Set([...(checked.levels ?? []), level])];
  checked.apply = (checked.apply ?? true) && applies;
}

/** The context port whose writes all land in the chat's branch, as a create in an Agents level must. */
export function draftContext(deps: ToolWiringDeps, call: ToolCall): ResolvedModelContextPort {
  return {
    resolution: call.context.resolution,
    port: contextPortForThread(deps.contextPorts, call.context.resolution, {
      destination: {
        kind: "draft",
        owner: call.execution.branchOwner,
        ownerHandle: call.execution.scope.workHandle,
      },
    }),
  };
}

/** The receipt says what the check did, in the words Changes uses for the same Agents. */
function withAgentsCheck(
  result: ModelEditHandlerResult,
  check: AgentsCheck,
): ModelEditHandlerResult {
  const lines = [
    ...(check.status === "applied" ? ["Applied: it makes no Agent wider."] : []),
    ...check.created,
    ...(check.status === "waiting" && check.labels.length > 0
      ? [`Waiting for review: ${check.labels.join("; ")}`]
      : []),
  ];
  if (lines.length === 0 || result.modelEdit.status === "never") return result;
  const note = lines.join("\n");
  const stored = result.modelEdit.result.toolResult;
  const body = stored.result;
  return {
    ...result,
    modelEdit: {
      ...result.modelEdit,
      result: {
        ...result.modelEdit.result,
        toolResult: {
          ...stored,
          content: [...stored.content, { type: "text", text: note }],
          result:
            typeof body === "object" && body !== null && !Array.isArray(body)
              ? { ...body, message: [body.message, note].filter(Boolean).join("\n") }
              : body,
        },
      },
    },
  };
}

function isCommandResult(value: unknown): value is ModelEditHandlerResult {
  return typeof value === "object" && value !== null && "modelEdit" in value;
}

/**
 * Settles the check for a write that landed in the chat's branch and says what it did on the
 * receipt. A write the grant didn't mark as an Agents write, or one that didn't commit, passes
 * through untouched.
 */
export async function checkAgentsWrite<R>(
  deps: Pick<ToolWiringDeps, "agentsWidening">,
  call: ToolCall,
  ctx: Pick<ToolHandlerContext, "toolCallId">,
  checked: AgentsCheckTarget,
  result: R,
): Promise<R> {
  if (!checked.levels || !isCommandResult(result) || result.modelEdit.status !== "done")
    return result;
  const thread = call.context.resolution.thread;
  const check = await deps.agentsWidening.settle({
    thread: { id: thread.id, userId: thread.userId, projectId: thread.projectId },
    owner: call.execution.branchOwner,
    levels: checked.levels,
    callId: ctx.toolCallId ?? randomUUID(),
    apply: checked.apply === true,
  });
  return withAgentsCheck(result, check) as R;
}
