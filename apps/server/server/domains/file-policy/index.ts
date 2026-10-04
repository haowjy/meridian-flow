/** Barrel: the file-policy domain's public surface. */

export { createDrizzleFileFacts } from "./adapters/drizzle-file-facts.js";
export {
  createLocalFileAccessChanges,
  createPgFileAccessChanges,
  type PgFileAccessChanges,
} from "./adapters/file-access-changes.js";
export { createOwnerFileGrants } from "./adapters/owner-file-grants.js";
export { createAllowAllFileAccess } from "./allow-all-file-access.js";
export { isDrafted, sourceDestination } from "./domain/policy.js";
export {
  type AgentChain,
  type AgentLink,
  type FileAccessDenial,
  type FileAccessDenied,
  type FileAccessLevel,
  type FileDestination,
  type FileFacts,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  type SkillFacts,
  type WorkRef,
} from "./domain/types.js";
export {
  FileEditRefusedError,
  markReplyConfirmed,
  runWithEditGrants,
  UngrantedAgentWriteError,
} from "./edit-confirmation.js";
export {
  createFileAccess,
  type FileAccess,
} from "./file-access.js";
export type { FileAccessChange, FileAccessChanges } from "./ports/file-access-changes.js";
