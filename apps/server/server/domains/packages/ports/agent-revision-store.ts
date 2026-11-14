/** Immutable Agent content and future-chat catalog selection. Callers own resource authorization. */
import type {
  InvocationOverlay,
  ResolvedAgentConfiguration,
  RetainedSkillReference,
} from "@meridian/contracts/agents";
import type {
  AgentSourceSnapshot,
  CompiledAgentDefinition,
  PackageDiagnostic,
} from "../domain/compile-package.js";

/** An available Agent as one reader version read it. The runtime never sees an unavailable one. */
export interface AgentRevision {
  id: string;
  packageRevisionId: string;
  slug: string;
  grammarVersion: string;
  definition: CompiledAgentDefinition;
}
/** One Agent file as one reader version read it: available (a definition) or unavailable (reasons). */
export interface CatalogRevision {
  id: string;
  packageRevisionId: string;
  slug: string;
  grammarVersion: string;
  name: string;
  description: string;
  diagnostics: PackageDiagnostic[];
  definition: CompiledAgentDefinition | null;
}
/** Retained per-thread binding; `revision` is null for an agent-less generic subagent. */
export interface AgentRevisionBinding {
  revision: AgentRevision | null;
  configuration: ResolvedAgentConfiguration;
  invocationOverlay: InvocationOverlay | null;
  /** Packaged skills the user invoked in this thread, by slug, pinned as read. */
  invokedSkills: Readonly<Record<string, RetainedSkillReference>>;
}
export interface AgentCatalogEntry {
  id: string;
  ownerUserId: string | null;
  logicalKey: string;
  selectedRevisionId: string;
  name: string;
  nameSortKey: string;
  removed: boolean;
}
export type AgentCatalogSelectionResult =
  | { ok: true; entry: AgentCatalogEntry }
  | { ok: false; reason: "conflict" | "not-found" };

/** Mutable management head over immutable sources, never consulted by bound execution. */
export interface AgentPackageInstallation {
  id: string;
  ownerUserId: string | null;
  coordinate: string;
  currentRevisionId: string;
}

export interface AgentRevisionStore {
  listInstallations(ownerUserId: string | null): Promise<AgentPackageInstallation[]>;
  /**
   * Installations of every owner whose current file set has no Agent rows at `grammarVersion`:
   * what a reader change left behind.
   */
  listInstallationsWithoutRows(grammarVersion: string): Promise<AgentPackageInstallation[]>;
  /** Exact head CAS, inside the owning publication transaction. */
  advanceInstallation(
    input: Omit<AgentPackageInstallation, "id"> & { expectedRevisionId?: string },
  ): Promise<AgentPackageInstallation | undefined>;

  /** Serialize complete owner-scoped catalog publications in one ambient transaction. */
  withCatalogTransaction<T>(ownerUserId: string | null, operation: () => Promise<T>): Promise<T>;
  /** Compiles the files under `grammarVersion` (the running reader by default) and retains them. */
  installSource(
    source: AgentSourceSnapshot,
    grammarVersion?: string,
  ): Promise<{ packageRevisionId: string; definitions: CatalogRevision[] }>;
  readSource(packageRevisionId: string): Promise<AgentSourceSnapshot | undefined>;
  /** By id, any reader version. Undefined for an unavailable Agent. */
  readRevision(id: string): Promise<AgentRevision | undefined>;
  /** By id, any reader version, available or not. */
  readCatalogRevision(id: string): Promise<CatalogRevision | undefined>;
  /** The available Agents of one file set, as read by `grammarVersion`. */
  readPackageDefinitions(
    packageRevisionId: string,
    grammarVersion: string,
  ): Promise<AgentRevision[]>;
  /** Every Agent of one file set, as read by `grammarVersion`. */
  readPackageCatalogRevisions(
    packageRevisionId: string,
    grammarVersion: string,
  ): Promise<CatalogRevision[]>;
  /** Null ownership is reserved for trusted system seeding. Existing pointers require an exact CAS. */
  selectRevision(input: {
    ownerUserId: string | null;
    logicalKey: string;
    revisionId: string;
    expectedRevisionId?: string;
  }): Promise<AgentCatalogSelectionResult>;
  readCatalogEntry(
    ownerUserId: string | null,
    logicalKey: string,
  ): Promise<AgentCatalogEntry | undefined>;
  /** Only a revision of the running reader's version: a stricter reader reaches held selections. */
  readSelection(
    userId: string,
    catalogEntryId: string,
    revisionId: string,
    projectId?: string,
  ): Promise<{ entry: AgentCatalogEntry; revision: CatalogRevision } | undefined>;
  listCatalog(input: {
    userId: string;
    projectId?: string;
    limit: number;
    after?: { nameSortKey: string; id: string };
  }): Promise<AgentCatalogEntry[]>;
  removeFromProject(projectId: string, catalogEntryId: string): Promise<void>;
  removeOwnedEntry(userId: string | null, entryId: string): Promise<boolean>;
  bindThread(
    threadId: string,
    revisionId: string | null,
    configuration: ResolvedAgentConfiguration,
    invocationOverlay: InvocationOverlay | null,
  ): Promise<boolean>;
  /** Throws when the bound revision has no definition: null `revision` means the generic subagent. */
  readThreadBinding(threadId: string): Promise<AgentRevisionBinding | undefined>;
  /**
   * Pins a user-invoked skill on the thread's binding, replacing an earlier
   * pin of the same slug. False when the thread has no binding.
   */
  recordInvokedSkill(
    threadId: string,
    slug: string,
    reference: RetainedSkillReference,
  ): Promise<boolean>;
}
