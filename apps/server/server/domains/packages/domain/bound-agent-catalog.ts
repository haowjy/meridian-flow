/** Account/system selection, immutable revision eligibility, and truthful runtime availability. */
import type { AgentCatalogEntry, AgentRevisionStore } from "../ports/agent-revision-store.js";
import type { CompiledAgentDefinition } from "./agent-definition-compiler.js";
import type { AgentSourceSnapshot } from "./agent-source-revision.js";

export interface AgentSelection {
  catalogEntryId: string;
  definitionRevisionId: string;
}
export interface BoundAgentCatalogItem {
  selection: AgentSelection;
  slug: string;
  name: string;
  description: string;
  ownership: "system" | "personal";
  unavailableReasons: string[];
}
export interface BoundAgentCatalog {
  installSystemSource(source: AgentSourceSnapshot): Promise<void>;
  list(
    userId: string,
    input: { limit: number; after?: { nameSortKey: string; id: string } },
  ): Promise<{
    agents: BoundAgentCatalogItem[];
    nextCursor: { nameSortKey: string; id: string } | null;
  }>;
  resolvePrimary(
    userId: string,
    selection: AgentSelection,
  ): Promise<
    | { ok: true; definition: CompiledAgentDefinition; packageRevisionId: string }
    | { ok: false; reason: "not-found" | "unavailable"; details: string[] }
  >;
}

export function createBoundAgentCatalog(input: {
  store: AgentRevisionStore;
  /** Host-owned routing/support checks, independent of source syntax compilation. */
  unavailableReasons(definition: CompiledAgentDefinition): string[];
}): BoundAgentCatalog {
  const { store } = input;
  const reasons = (definition: CompiledAgentDefinition): string[] => {
    const result = input.unavailableReasons(definition);
    if (
      definition.metadata.mode === "subagent" ||
      definition.metadata["user-invocable"] === false
    ) {
      return ["This Agent is unavailable for primary conversations", ...result];
    }
    return result;
  };
  const summarize = async (entry: AgentCatalogEntry): Promise<BoundAgentCatalogItem> => {
    const revision = await store.readRevision(entry.selectedRevisionId);
    if (!revision) throw new Error("Agent catalog references a missing revision");
    return {
      selection: { catalogEntryId: entry.id, definitionRevisionId: revision.id },
      slug: revision.slug,
      name: revision.definition.metadata.name ?? revision.slug,
      description: revision.definition.metadata.description ?? "",
      ownership: entry.ownerUserId === null ? "system" : "personal",
      unavailableReasons: reasons(revision.definition),
    };
  };
  return {
    async installSystemSource(source) {
      return store.withSystemCatalogTransaction(async () => {
        const installed = await store.installSource(source);
        for (const revision of installed.definitions) {
          const existing = await store.readCatalogEntry(null, revision.slug);
          if (existing) {
            const previous = await store.readRevision(existing.selectedRevisionId);
            const previousSource = previous && (await store.readSource(previous.packageRevisionId));
            if (previousSource?.coordinate !== source.coordinate) {
              throw new Error(`System Agent source collision: ${revision.slug}`);
            }
          }
          if (existing?.selectedRevisionId === revision.id || existing?.removed) continue;
          const selected = await store.selectRevision({
            ownerUserId: null,
            logicalKey: revision.slug,
            revisionId: revision.id,
            ...(existing ? { expectedRevisionId: existing.selectedRevisionId } : {}),
          });
          if (!selected.ok) {
            const current = await store.readCatalogEntry(null, revision.slug);
            if (current?.selectedRevisionId !== revision.id)
              throw new Error(`System Agent selection conflict: ${revision.slug}`);
          }
        }
      });
    },
    async list(userId, page) {
      const entries = await store.listCatalog({ userId, limit: page.limit, after: page.after });
      const last = entries.at(-1);
      return {
        agents: await Promise.all(entries.map(summarize)),
        nextCursor:
          entries.length === page.limit && last
            ? { nameSortKey: last.nameSortKey, id: last.id }
            : null,
      };
    },
    async resolvePrimary(userId, selection) {
      const resolved = await store.readSelection(
        userId,
        selection.catalogEntryId,
        selection.definitionRevisionId,
      );
      if (!resolved) return { ok: false, reason: "not-found", details: [] };
      const unavailable = reasons(resolved.revision.definition);
      if (unavailable.length) return { ok: false, reason: "unavailable", details: unavailable };
      return {
        ok: true,
        definition: resolved.revision.definition,
        packageRevisionId: resolved.revision.packageRevisionId,
      };
    },
  };
}
