/** Resolve a model-visible missing path through the tree history that powers model Undo. */
import type { DocumentCommandName } from "@meridian/agent-edit/integration";
import type { ProjectId, ThreadId } from "@meridian/contracts";
import { removedFileResult } from "../file-access-denial-copy.js";
import {
  canonicalPath,
  type ToolCall,
  type ToolWiringDeps,
  type WriteToolErrorOutput,
} from "./tool-context.js";

/** A missing path whose latest holder this chat removed, when its retained record is readable. */
export async function removedPathError(
  deps: ToolWiringDeps,
  call: ToolCall,
  command: DocumentCommandName,
  path: string,
  threadId: string,
): Promise<WriteToolErrorOutput | null> {
  const canonical = await canonicalPath(call, path);
  const away = await deps.documentSync.treeHistory().movedAwayFrom(threadId as ThreadId, canonical);
  if (!away || (await deps.fileAccess.historyAccess(call.principal, away)) !== "deleted") {
    return null;
  }
  const retained = await deps.documentTrash.retained(
    call.context.resolution.thread.projectId as ProjectId,
    [away],
  );
  if (!retained.has(away)) return null;
  const removal = (await deps.documentRemovals.lookup([away])).get(away);
  return removal ? removedFileResult(command, removal, canonical) : null;
}
