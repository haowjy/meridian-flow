/** Barrel: the file-policy domain's public surface. */

export { createDrizzleFileFacts } from "./adapters/drizzle-file-facts.js";
export {
  createLocalFileAccessChanges,
  createPgFileAccessChanges,
  type PgFileAccessChanges,
} from "./adapters/file-access-changes.js";
export { createOwnerFileGrants } from "./adapters/owner-file-grants.js";
export { createAllowAllFileAccess } from "./allow-all-file-access.js";
export { matchAncestors, nodeChain } from "./domain/ancestors.js";
export { isDrafted, type NodeGrant, sourceDestination } from "./domain/policy.js";
export {
  type AgentChain,
  type AgentLink,
  atLeast,
  chainPermission,
  type FileAccessDenial,
  type FileAccessDenied,
  type FileAccessLevel,
  type FileAccessLimit,
  type FileDecision,
  type FileDestination,
  type FileFacts,
  type FileGrant,
  type FileNeed,
  type FileNode,
  type FileOwnerRef,
  type FileTarget,
  type FileWorkFacts,
  isFileAccessDenied,
  type Principal,
  type WorkRef,
} from "./domain/types.js";
export {
  FileEditRefusedError,
  grantWorkIds,
  markReplyConfirmed,
  runWithEditGrants,
  UngrantedAgentWriteError,
} from "./edit-confirmation.js";
export {
  createFileAccess,
  type FileAccess,
  type FileAccessDeps,
  type FileEditConfirmation,
} from "./file-access.js";
export type { FileAccessChange, FileAccessChanges } from "./ports/file-access-changes.js";
export type { FileFactsPort, FileFactsRequest } from "./ports/file-facts.js";
export type { FileGrantsPort } from "./ports/file-grants.js";
