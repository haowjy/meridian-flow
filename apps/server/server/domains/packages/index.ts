// @ts-nocheck
// Package domain public surface: exports only the active repository-backed Mars package runtime.
export { createDrizzlePackageStore } from "./adapters/drizzle-package-store.js";
export {
  createGitHubMarsPackageFetcher,
  type GitHubMarsPackageFetcherDeps,
  parseGitHubRepoUrl,
} from "./adapters/github-mars-package-fetcher.js";
export type {
  InMemoryPackageStore,
  InMemoryPackageStoreSeed,
} from "./adapters/in-memory-package-store.js";
export { createInMemoryPackageStore } from "./adapters/in-memory-package-store.js";
export {
  listBuiltinCatalogAgents,
  listWorkbenchCatalogAgents,
} from "./domain/agent-catalog.js";
export {
  type AgentEffort,
  type AgentEffortLevel,
  type AgentGatewayMeta,
  extractAgentGatewayMeta,
  normalizeAgentEffort,
  normalizeAgentMetaFields,
} from "./domain/agent-gateway-meta.js";
export {
  createDefaultPackageSeeder,
  type DefaultPackageSeedConfig,
  type DefaultPackageSeeder,
  type DefaultPackageSeedResult,
  defaultPackageSeedConfigFromEnv,
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
  seedInitialAgentRevision,
  seedInitialSkillRevision,
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
export type { ImportMarsPackageInput } from "./domain/package-sync.js";
export {
  importLocalMarsPackage,
  previewLocalMarsPackageImport,
  previewLocalMarsPackageUpdate,
  updateLocalMarsPackage,
} from "./domain/package-sync.js";
export { buildMarsPackageZip } from "./domain/package-zip.js";
export { resolveAgentSkills } from "./domain/resolution.js";
export {
  type SkillExecutionDescriptor,
  skillExecutionDescriptorFromResolvedSkill,
} from "./domain/skill-execution-descriptor.js";
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
  AgentDefinitionRecord,
  AgentSkillLinkRecord,
  ExportedMarsDirectory,
  JsonObject,
  MarsDependency,
  MarsPackageMetadata,
  PackageImportResult,
  PackageInstallRecord,
  PackageUpdateResult,
  PackageVisibility,
  ParsedAgentDefinition,
  ParsedMarsPackageSource,
  ParsedMarsToml,
  ParsedSkillDefinition,
  ResolvedPackageContext,
  ResolvedSkill,
  SkillRecord,
  UserInstalledSkillRecord,
} from "./domain/types.js";
export { listWorkbenchLibraryInventory } from "./domain/workbench-library.js";
export type {
  FetchedMarsSource,
  MarsPackageFetcher,
} from "./ports/mars-package-fetcher.js";
export { fetchedMarsSourceFromDirectory } from "./ports/mars-package-fetcher.js";
export type { PackageRepository, PackageWriteTransaction } from "./ports/package-store.js";
