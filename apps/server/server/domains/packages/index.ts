// Public package reading, compilation, catalog, and persistence surface.

export { createDrizzleAgentRevisionStore } from "./adapters/drizzle-agent-revision-store.js";
export {
  createInMemoryAgentRevisionStore,
  type InMemoryAgentRevisionStore,
} from "./adapters/in-memory-agent-revision-store.js";
export {
  AgentConfigurationError,
  buildRetainedSkillResolver,
  type RetainedSkillResolver,
  resolveAgentConfiguration,
} from "./domain/agent-configuration.js";
export {
  type AgentSelection,
  AgentSelectionError,
  type BoundAgentCatalog,
  type BoundAgentCatalogItem,
  type CatalogSkill,
  createBoundAgentCatalog,
  isPrimary,
} from "./domain/bound-agent-catalog.js";
export {
  AgentSourceError,
  type AgentSourceSnapshot,
  type CompiledAgentDefinition,
  type PackageDiagnostic,
} from "./domain/compile-package.js";
export { generalAgentSource, readBuiltinPackages } from "./domain/default-package-seeding.js";
export { type SkillListing, skillListingFromMarkdown } from "./domain/skill-listing.js";
export type { SkillFiles } from "./domain/types.js";
export {
  type AgentLevelFiles,
  type ApplyFilesInput,
  type FileChange,
  type FileChanges,
  type LevelFiles,
  noLevelFiles,
} from "./ports/agent-level-files.js";
export type {
  AgentRevision,
  AgentRevisionBinding,
  AgentRevisionStore,
} from "./ports/agent-revision-store.js";
