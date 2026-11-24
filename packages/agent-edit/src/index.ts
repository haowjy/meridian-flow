// Deep public facade for the agent editing core.
export { splitDocumentFile } from "./document-address.js";
export { fullHashForBlockId } from "./model/block-hash.js";
export { bodyRange, destinationFreeBlocks, grepBlockText } from "./model/grep-text.js";
export type { Hashline } from "./model/hashline.js";
export { splitHashline, toHashline } from "./model/hashline.js";
export { markdownPlainText, markdownTextView } from "./model/markdown-text-view.js";
export {
  markdownSections,
  normalizeRequestedSlug,
  sectionNotFoundMessage,
} from "./resolver/heading-sections.js";
export type {
  DocumentCommandName,
  DocumentVersion,
  NamespaceCommandName,
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
export { DOCUMENT_NOT_FOUND_MESSAGE } from "./tool/internal-result.js";
export type {
  AgentEditBlockGroup,
  AgentEditBlockItem,
  AgentEditConcurrentListing,
  AgentEditResultCommand,
  AgentEditResultV1,
} from "./tool/model-result.js";
export {
  AGENT_EDIT_RESULT_SCHEMA,
  type AgentEditTreeFacts,
  agentEditResultCommand,
  isAgentEditResultEnvelope,
  modelResult,
} from "./tool/model-result.js";
export { readStaticMarkdown } from "./tool/read-static.js";
export { removedFile, removerName, survivingDraftNotice } from "./tool/removal-copy.js";
export {
  agentEditResultSummary,
  renderAgentEditResult,
} from "./tool/result-text.js";
export type {
  MutationActor,
  UnexpectedWriteErrorDetail,
  WriteContext,
  WriteErrorStatus,
  WriteOutcome,
  WriteStatus,
} from "./tool/types.js";
