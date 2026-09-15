// Public package parsing, compilation, catalog, and persistence surface.

export { createDrizzleAgentRevisionStore } from "./adapters/drizzle-agent-revision-store.js";
export {
  createGitHubMarsPackageFetcher,
  type GitHubMarsPackageFetcherDeps,
  parseGitHubRepoUrl,
} from "./adapters/github-mars-package-fetcher.js";
export {
  createInMemoryAgentRevisionStore,
  type InMemoryAgentRevisionStore,
} from "./adapters/in-memory-agent-revision-store.js";
export {
  AgentConfigurationError,
  resolveAgentConfiguration,
} from "./domain/agent-configuration.js";
export {
  type AgentCompilationDiagnostic,
  type AgentCompilationResult,
  type CompiledAgentDefinition,
  compileAgentDefinition,
  type NormalizedAgentMetadata,
} from "./domain/agent-definition-compiler.js";
export {
  type AgentEffort,
  type AgentEffortLevel,
  normalizeAgentEffort,
  normalizeAgentMetaFields,
} from "./domain/agent-gateway-meta.js";
export {
  AgentSourceError,
  type AgentSourceSnapshot,
  prepareAgentSourceRevision,
} from "./domain/agent-source-revision.js";
export {
  AgentPublicationConflictError,
  type AgentSelection,
  AgentSelectionError,
  type BoundAgentCatalog,
  type BoundAgentCatalogItem,
  createBoundAgentCatalog,
} from "./domain/bound-agent-catalog.js";
export {
  type DefaultPackageSeedConfig,
  defaultPackageSeedConfigFromEnv,
  seedDefaultAgentPackages,
  seedGeneralAgent,
} from "./domain/default-package-seeding.js";
export {
  DefinitionEditError,
  listAgentDefinitionRevisions,
  listSkillDefinitionRevisions,
  patchAgentSkillLink,
  restoreAgentDefinitionOriginal,
  restoreAgentDefinitionRevision,
  restoreSkillDefinitionOriginal,
  restoreSkillDefinitionRevision,
  saveAgentDefinition,
  saveSkillDefinition,
} from "./domain/definition-editing.js";
export {
  FIRST_PARTY_CATALOG,
  listFirstPartyCatalog,
  resolveCatalogSource,
} from "./domain/first-party-catalog.js";
export {
  agentDefinitionContentChecksum,
  agentModeFromMeta,
  canonicalizeJsonObject,
  definitionContentChecksum,
  loadAgentDefinitions,
  loadSkillDefinitions,
  normalizeAgentMeta,
  parseAgentDefinitionFile,
  parseMarkdownDefinition,
  parseMarsPackageSource,
  parseMarsToml,
  parseSkillDefinitionFile,
  serializeMarkdownDefinition,
} from "./domain/mars-source.js";
export { exportMarsPackage, writeExportedMarsDirectory } from "./domain/package-export.js";
export {
  isPackageImportError,
  PackageImportError,
  packageDependencyUnresolved,
} from "./domain/package-import-error.js";
export {
  applyPackageInstall,
  applyPackageUpdate,
  checkPackageUpdate,
  findOwnedPackageInstall,
  previewPackageInstall,
  resolvePackageInstallSource,
} from "./domain/package-install-ops.js";
export { buildMarsPackageZip } from "./domain/package-zip.js";
export {
  bufferToSkillFileEntry,
  normalizeSkillFilesForChecksum,
  readSkillFileFromDisk,
  skillFileEntryToBuffer,
  skillFilesFromJson,
  writeSkillFileToDisk,
} from "./domain/skill-files.js";
export type {
  AgentConfigOverlay,
  ExportedMarsDirectory,
  JsonObject,
  MarsDependency,
  MarsPackageMetadata,
  PackageVisibility,
  ParsedAgentDefinition,
  ParsedMarsPackageSource,
  ParsedMarsToml,
  ParsedSkillDefinition,
} from "./domain/types.js";
export type {
  AgentCatalogEntry,
  AgentCatalogSelectionResult,
  AgentRevision,
  AgentRevisionStore,
  BoundAgentRevision,
} from "./ports/agent-revision-store.js";
export type {
  FetchedMarsSource,
  MarsPackageFetcher,
} from "./ports/mars-package-fetcher.js";
export { fetchedMarsSourceFromDirectory } from "./ports/mars-package-fetcher.js";
