/** Immutable Agent content and future-chat catalog selection. Callers own resource authorization. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { CompiledAgentDefinition } from "../domain/agent-definition-compiler.js";
import type { AgentSourceSnapshot } from "../domain/agent-source-revision.js";

export interface AgentRevision {
  id: string;
  packageRevisionId: string;
  slug: string;
  definition: CompiledAgentDefinition;
  definitionDigest: string;
}
export interface BoundAgentRevision extends AgentRevision {
  configuration: ResolvedAgentConfiguration;
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
  upstreamRevisionId: string;
  origin: { url: string; ref: string; commitSha: string | null } | null;
}
export interface AgentPackageHistoryEntry {
  packageRevisionId: string;
  createdAt: string;
}

export interface AgentRevisionStore {
  listInstallations(ownerUserId: string | null): Promise<AgentPackageInstallation[]>;
  readInstallationHistory(
    ownerUserId: string | null,
    installationId: string,
  ): Promise<AgentPackageHistoryEntry[]>;
  /** Exact head CAS plus retained history, inside the owning publication transaction. */
  advanceInstallation(
    input: Omit<AgentPackageInstallation, "id"> & { expectedRevisionId?: string },
  ): Promise<AgentPackageInstallation | undefined>;

  /** Serialize complete owner-scoped catalog publications in one ambient transaction. */
  withCatalogTransaction<T>(ownerUserId: string | null, operation: () => Promise<T>): Promise<T>;
  installSource(
    source: AgentSourceSnapshot,
  ): Promise<{ packageRevisionId: string; definitions: AgentRevision[] }>;
  readSource(packageRevisionId: string): Promise<AgentSourceSnapshot | undefined>;
  readRevision(id: string): Promise<AgentRevision | undefined>;
  readPackageDefinitions(packageRevisionId: string): Promise<AgentRevision[]>;
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
  readSelection(
    userId: string,
    catalogEntryId: string,
    revisionId: string,
    projectId?: string,
  ): Promise<{ entry: AgentCatalogEntry; revision: AgentRevision } | undefined>;
  listCatalog(input: {
    userId: string;
    projectId?: string;
    limit: number;
    after?: { nameSortKey: string; id: string };
  }): Promise<AgentCatalogEntry[]>;
  removeFromProject(projectId: string, catalogEntryId: string): Promise<void>;
  removeOwnedEntry(userId: string | null, entryId: string): Promise<boolean>;
  restoreOwnedEntry(userId: string, entryId: string, expectedRevisionId: string): Promise<boolean>;
  bindThread(
    threadId: string,
    revisionId: string,
    configuration: ResolvedAgentConfiguration,
  ): Promise<boolean>;
  readThreadBinding(threadId: string): Promise<BoundAgentRevision | undefined>;
}
