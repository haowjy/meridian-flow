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

export interface AgentRevisionStore {
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
  ): Promise<{ entry: AgentCatalogEntry; revision: AgentRevision } | undefined>;
  listCatalog(input: {
    userId: string;
    limit: number;
    after?: { nameSortKey: string; id: string };
  }): Promise<AgentCatalogEntry[]>;
  removeOwnedEntry(userId: string, entryId: string): Promise<boolean>;
  restoreOwnedEntry(userId: string, entryId: string, expectedRevisionId: string): Promise<boolean>;
  bindThread(
    threadId: string,
    revisionId: string,
    configuration: ResolvedAgentConfiguration,
  ): Promise<boolean>;
  readThreadBinding(threadId: string): Promise<BoundAgentRevision | undefined>;
}
