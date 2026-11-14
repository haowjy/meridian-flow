/** Immutable Agent content a chat is bound to. Callers own resource authorization. */
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
export interface AgentRevisionStore {
  /**
   * Compiles the files under `grammarVersion` (the running reader by default) and retains them
   * with their Agent rows, once per (coordinate, content digest, reader version). Nothing else
   * points at them but a chat's binding.
   */
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
