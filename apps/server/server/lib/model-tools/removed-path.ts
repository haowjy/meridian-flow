/** Resolve a model-visible missing path through the tree history that powers model Undo. */
import type { DocumentCommandName } from "@meridian/agent-edit/integration";
import { deserializeRemovalIdentity, type ThreadId } from "@meridian/contracts";
import { parseContextUri } from "@meridian/contracts/context-uri";
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
  if (away && (await deps.fileAccess.historyAccess(call.principal, away)) === "deleted") {
    const removal = (await deps.documentRemovals.lookup([away])).get(away);
    if (removal) return removedFileResult(command, removal, canonical);
  }

  const parsed = parseContextUri(canonical);
  if (!parsed.ok) return null;
  const entry = (await deps.documentTrash.list(call.context.resolution.thread.projectId)).find(
    (candidate) =>
      candidate.scheme === parsed.value.scheme && candidate.formerPath === parsed.value.path,
  );
  if (!entry) return null;
  return removedFileResult(
    command,
    {
      reason: "deleted",
      actor: entry.actor,
      time: deserializeRemovalIdentity(entry.removal).time.toISOString(),
    },
    canonical,
  );
}
