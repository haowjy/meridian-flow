/** Barrel: the file-policy domain's public surface. */

export { createDrizzleFileFacts } from "./adapters/drizzle-file-facts.js";
export {
  createLocalFileAccessChanges,
  createPgFileAccessChanges,
  type PgFileAccessChanges,
} from "./adapters/file-access-changes.js";
export { createOwnerFileGrants } from "./adapters/owner-file-grants.js";
export { createAllowAllFileAccess } from "./allow-all-file-access.js";
export { isDrafted, skillLevel, sourceDestination } from "./domain/policy.js";
export {
  type AgentChain,
  type AgentLink,
  type FileAccessDenial,
  type FileAccessDenied,
  type FileDestination,
  type FileFacts,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  grantWorkIds,
  isFileAccessDenied,
  type Principal,
  type SkillFacts,
  targetDocumentId,
  type WorkRef,
} from "./domain/types.js";
export {
  FileEditRefusedError,
  markReplyConfirmed,
  runWithEditGrants,
} from "./edit-confirmation.js";
export {
  createFileAccess,
  type FileAccess,
} from "./file-access.js";
export type { FileAccessChange, FileAccessChanges } from "./ports/file-access-changes.js";
