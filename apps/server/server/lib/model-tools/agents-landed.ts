/**
 * What an AI's write into an Agents level made wider, said on the write's own tool result so the
 * chat card can show it (`agentsWidened`, read by the thread client). Display only: it never
 * routes, holds or blocks the write, and a write that stayed a draft changes nothing live, so it
 * says nothing.
 */
import type { WriteToolInput } from "@meridian/agent-edit/integration";
import type { AgentsLevel } from "@meridian/contracts/agents";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ModelEditHandlerResult, ToolHandlerContext } from "../../domains/runtime/index.js";
import { agentsLevelOfPath } from "./shown-paths.js";
import type { ToolWiringDeps } from "./tool-context.js";

/** The Agents levels the paths a write names are in. */
function levelsOf(input: WriteToolInput): AgentsLevel[] {
  const { path, from } = input as {
    path?: string;
    from?: { path?: string; paths?: string[] };
  };
  const named = [path, from?.path, ...(from?.paths ?? [])].filter(
    (each): each is string => typeof each === "string",
  );
  return [...new Set(named.flatMap((each) => agentsLevelOfPath(each) ?? []))];
}

function isCommandResult(value: unknown): value is ModelEditHandlerResult {
  return typeof value === "object" && value !== null && "modelEdit" in value;
}

export async function withLandedWidening<R>(
  deps: Pick<ToolWiringDeps, "threads" | "agentsWidening">,
  ctx: Pick<ToolHandlerContext, "threadId">,
  input: WriteToolInput,
  write: () => Promise<R>,
): Promise<R> {
  const levels = levelsOf(input);
  const thread = levels.length > 0 ? await deps.threads.findById(ctx.threadId as ThreadId) : null;
  if (!thread) return write();
  const landed = await deps.agentsWidening.watchLive({
    userId: thread.userId,
    projectId: thread.projectId,
    levels,
  });
  const result = await write();
  if (!isCommandResult(result) || result.modelEdit.status !== "done") return result;
  const widened = await landed();
  if (widened.length === 0) return result;
  const stored = result.modelEdit.result.toolResult;
  return {
    ...result,
    modelEdit: {
      ...result.modelEdit,
      result: {
        ...result.modelEdit.result,
        toolResult: { ...stored, metadata: { ...stored.metadata, agentsWidened: widened } },
      },
    },
  } as R;
}
