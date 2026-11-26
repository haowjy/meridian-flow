import type {
  DocumentVersion,
  FrontierLookup,
  ReadToolInput,
  WriteOutcome,
} from "@meridian/agent-edit/integration";
import { formatDocumentFile } from "@meridian/agent-edit/integration";
import type { FileGrant } from "../../domains/file-policy/index.js";
import type { ToolHandlerContext } from "../../domains/runtime/index.js";
import type { ResolvedDocumentAddress, ToolWiringDeps } from "./tool-context.js";

export type ReadSelection = Pick<ReadToolInput, "in" | "around" | "before">;

export async function readDocument(
  deps: Pick<ToolWiringDeps, "documentSync">,
  grant: FileGrant,
  address: ResolvedDocumentAddress,
  options: {
    selection?: ReadSelection;
    format?: ReadToolInput["format"];
    version?: DocumentVersion;
    includeNodes?: boolean;
    recordingFrontier?: FrontierLookup;
    inCommand?: boolean;
  },
  ctx: Pick<ToolHandlerContext, "threadId" | "turnId" | "responseIdentity" | "toolCallId">,
): Promise<WriteOutcome> {
  const read = options.inCommand
    ? deps.documentSync.modelEdits().read
    : deps.documentSync.agentEdit().read;
  return read(
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
      ...(options.recordingFrontier ? { frontiers: { recording: options.recordingFrontier } } : {}),
      ...(ctx.toolCallId ? { tool_use_id: ctx.toolCallId } : {}),
    },
  );
}
