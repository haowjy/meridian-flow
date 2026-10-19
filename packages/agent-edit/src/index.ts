// Deep public facade for the agent editing core.
import { type CreateWriteToolOptions, createWriteTool } from "./tool/write.js";

// A host's response-attempt surface (`ResponseCommitAttempt`, `ResponseAttemptStaleError`) is
// exported once, from `integration.ts`.

export type AgentEditCoreOptions = CreateWriteToolOptions;

export interface AgentEditCore {
  read: ReturnType<typeof createWriteTool>["read"];
  write: ReturnType<typeof createWriteTool>["write"];
  commitResponse: ReturnType<typeof createWriteTool>["commitResponse"];
  prepareResponse: ReturnType<typeof createWriteTool>["prepareResponse"];
  rollbackResponse: ReturnType<typeof createWriteTool>["rollbackResponse"];
  hasResponseDocument: ReturnType<typeof createWriteTool>["hasResponseDocument"];
  readRoom: ReturnType<typeof createWriteTool>["readRoom"];
  responseDocuments: ReturnType<typeof createWriteTool>["responseDocuments"];
  refuseStaged: ReturnType<typeof createWriteTool>["refuseStaged"];
  retirePeer: ReturnType<typeof createWriteTool>["retirePeer"];
  dropStaged: ReturnType<typeof createWriteTool>["dropStaged"];
}

export function createAgentEditCore(options: AgentEditCoreOptions): AgentEditCore {
  const tool = createWriteTool(options);
  return {
    read: tool.read,
    write: tool.write,
    commitResponse: tool.commitResponse,
    prepareResponse: tool.prepareResponse,
    rollbackResponse: tool.rollbackResponse,
    hasResponseDocument: tool.hasResponseDocument,
    readRoom: tool.readRoom,
    responseDocuments: tool.responseDocuments,
    refuseStaged: tool.refuseStaged,
    retirePeer: tool.retirePeer,
    dropStaged: tool.dropStaged,
  };
}

export { splitDocumentFile } from "./document-address.js";
export type { BlockHashLookup, BlockItemId } from "./model/block-hash.js";
export { getBlockItemId, lookupBlockHash } from "./model/block-hash.js";
export type { Hashline } from "./model/hashline.js";
export { splitHashline, toHashline } from "./model/hashline.js";
export { markdownPlainText } from "./model/markdown-text-view.js";
export type { LiveBlockRangeTarget } from "./model/navigation-target.js";
export {
  decodeNavigationPosition,
  encodeNavigationPosition,
  isBlockItemId,
  validateLiveBlockRange,
} from "./model/navigation-target.js";
export {
  markdownSections,
  normalizeRequestedSlug,
  sectionNotFoundMessage,
} from "./resolver/heading-sections.js";
export type {
  DocumentCommandName,
  DocumentVersion,
  ReadCommand,
  ReadToolInput,
  WriteCommand,
  WriteCommandName,
  WriteToolInput,
} from "./tool/command-schema.js";
export {
  DOCUMENT_NAMES_DESCRIPTION,
  DocumentVersionSchema,
  ReadCommandSchema,
  ReadToolInputSchema,
  WriteCommandSchema,
  WriteToolInputSchema,
  writeCommandName,
} from "./tool/command-schema.js";
export { documentNotFoundMessage } from "./tool/internal-result.js";
export type {
  AgentEditBlockGroup,
  AgentEditBlockItem,
  AgentEditConcurrentListing,
  AgentEditResultCommand,
  AgentEditResultV1,
} from "./tool/model-result.js";
export {
  AGENT_EDIT_RESULT_SCHEMA,
  agentEditResultCommand,
  isAgentEditResultEnvelope,
  modelBlockItem,
  modelResult,
  type WriteRejection,
} from "./tool/model-result.js";
export {
  agentEditResultSummary,
  readCall,
  renderAgentEditResult,
} from "./tool/result-text.js";
export type {
  MutationActor,
  ReadFunction,
  ResponseClaimDiscardedEntry,
  ResponseCommitDocumentResult,
  ResponseCommitSuccessResult,
  ResponseCommitterTransitionDetail,
  ResponseCommitWriteReceipt,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleErrorDetail,
  ResponseLifecycleEvent,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  UnexpectedWriteErrorDetail,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteIdempotencyHitDetail,
  WriteOutcome,
  WriteStatus,
  WriteSuccessPhase,
} from "./tool/types.js";
