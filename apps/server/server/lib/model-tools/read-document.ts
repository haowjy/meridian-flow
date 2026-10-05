/**
 * The one server read path (D18): the `read` tool, a copy's source read and
 * reference loading all call `readDocument`; nothing builds tool arguments to
 * reach it.
 */
import type {
  DocumentVersion,
  ReadToolInput,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import { formatDocumentFile } from "@meridian/agent-edit/integration";
import type { FileGrant } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import type { ResolvedDocumentAddress, ToolWiringDeps } from "./tool-context.js";

/** Which blocks a read renders, as the `read` tool's selector fields. */
export type ReadSelection = Pick<ReadToolInput, "in" | "around">;

/**
 * Omitted `version` reads where this thread's writes go; `live` never touches
 * a draft (D3, D14).
 */
export async function readDocument(
  deps: Pick<ToolWiringDeps, "documentSync">,
  grant: FileGrant,
  address: ResolvedDocumentAddress,
  options: {
    selection?: ReadSelection;
    format?: ReadToolInput["format"];
    version?: DocumentVersion;
    /** A copy's source read also returns the selected blocks as nodes. */
    includeNodes?: boolean;
  },
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseId" | "toolCallId">,
): Promise<WriteOutcome> {
  return deps.documentSync.agentEdit().read(
    {
      ...options.selection,
      ...(options.format ? { format: options.format } : {}),
      file: formatDocumentFile(address),
      documentId: address.documentId,
    },
    {
      sessionId: ctx.threadId,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      grant,
      ...(options.version === "live" ? { liveVersion: true } : {}),
      ...(options.includeNodes ? { includeNodes: true } : {}),
      ...(ctx.responseId ? { responseId: ctx.responseId } : {}),
      ...(ctx.toolCallId ? { tool_use_id: ctx.toolCallId } : {}),
    },
  );
}
