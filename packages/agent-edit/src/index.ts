// Deep public facade for the agent editing core.
import { type CreateWriteToolOptions, createWriteTool } from "./tool/write.js";

export type AgentEditCoreOptions = CreateWriteToolOptions;

export interface AgentEditCore {
  read: ReturnType<typeof createWriteTool>["read"];
  write: ReturnType<typeof createWriteTool>["write"];
  recover: ReturnType<typeof createWriteTool>["recover"];
  commitResponse: ReturnType<typeof createWriteTool>["commitResponse"];
  rollbackResponse: ReturnType<typeof createWriteTool>["rollbackResponse"];
  hasResponseDocument: ReturnType<typeof createWriteTool>["hasResponseDocument"];
  withResponseDocument: ReturnType<typeof createWriteTool>["withResponseDocument"];
  responseDocuments: ReturnType<typeof createWriteTool>["responseDocuments"];
  getAvailability: ReturnType<typeof createWriteTool>["getAvailability"];
  undo: ReturnType<typeof createWriteTool>["undo"];
  redo: ReturnType<typeof createWriteTool>["redo"];
  reverse: ReturnType<typeof createWriteTool>["reverse"];
  invalidateThread: ReturnType<typeof createWriteTool>["invalidateThread"];
}

export function createAgentEditCore(options: AgentEditCoreOptions): AgentEditCore {
  const tool = createWriteTool(options);
  return {
    read: tool.read,
    write: tool.write,
    recover: tool.recover,
    commitResponse: tool.commitResponse,
    rollbackResponse: tool.rollbackResponse,
    hasResponseDocument: tool.hasResponseDocument,
    withResponseDocument: tool.withResponseDocument,
    responseDocuments: tool.responseDocuments,
    getAvailability: tool.getAvailability,
    undo: tool.undo,
    redo: tool.redo,
    reverse: tool.reverse,
    invalidateThread: tool.invalidateThread,
  };
}

export type {
  Binding,
  CorrespondenceInput,
  CorrespondenceResult,
  OldOccurrence,
  ShownLink,
  WrittenLink,
} from "./link-correspondence.js";
export { correspondLinks, correspondLinksWithDiagnostics } from "./link-correspondence.js";
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
  AgentEditConcurrentRun,
  AgentEditResultCommand,
  AgentEditResultV1,
} from "./tool/model-result.js";
export {
  AGENT_EDIT_RESULT_SCHEMA,
  agentEditResultCommand,
  isAgentEditResultEnvelope,
  modelBlockItem,
  modelConcurrentResult,
  modelResult,
} from "./tool/model-result.js";
export {
  agentEditResultSummary,
  readCall,
  renderAgentEditResult,
} from "./tool/result-text.js";
export type {
  MutationActor,
  ReadFunction,
  RedoResult,
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
  UndoResult,
  UnexpectedWriteErrorDetail,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteIdempotencyHitDetail,
  WriteOutcome,
  WriteStatus,
  WriteSuccessPhase,
} from "./tool/types.js";
export type {
  ReverseInput,
  VerifiedReverseEffect,
  VerifiedReverseResult,
} from "./tool/write-reversal-endpoints.js";
