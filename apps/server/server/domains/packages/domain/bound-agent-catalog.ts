/** Account/system selection, immutable revision eligibility, and truthful runtime availability. */
import type {
  AgentCatalogPage,
  AgentSelection,
  AgentCatalogItem as BoundAgentCatalogItem,
  ResolvedAgentConfiguration,
} from "@meridian/contracts/agents";
import type {
  AgentCatalogEntry,
  AgentRevision,
  AgentRevisionStore,
} from "../ports/agent-revision-store.js";
import { AgentConfigurationError, resolveAgentConfiguration } from "./agent-configuration.js";
import type { CompiledAgentDefinition } from "./agent-definition-compiler.js";
import type { AgentSourceSnapshot } from "./agent-source-revision.js";
import { AgentPublicationConflictError, publishAgentSource } from "./source-publication.js";

export type {
  AgentCatalogItem as BoundAgentCatalogItem,
  AgentSelection,
} from "@meridian/contracts/agents";
export class AgentSelectionError extends Error {
  constructor(public readonly agentRef: string) {
    super(`Agent not found or unavailable: ${agentRef}`);
    this.name = "AgentSelectionError";
  }
}

export { AgentPublicationConflictError } from "./source-publication.js";

export interface BoundAgentCatalog {
  /** Import or revise one personal standalone Agent without a mutable intermediate record. */
  save(
    userId: string,
    input: { slug: string; content: string; expectedRevisionId?: string },
  ): Promise<BoundAgentCatalogItem>;
  installSystemSource(source: AgentSourceSnapshot): Promise<void>;
  list(
    userId: string,
    input: { limit: number; projectId?: string; after?: { nameSortKey: string; id: string } },
  ): Promise<AgentCatalogPage>;
  removeFromProject(userId: string, projectId: string, selection: AgentSelection): Promise<boolean>;
  resolvePrimary(
    userId: string,
    selection: AgentSelection,
    projectId?: string,
  ): Promise<
    | { ok: true; revision: AgentRevision; configuration: ResolvedAgentConfiguration }
    | { ok: false; reason: "not-found" | "unavailable"; details: string[] }
  >;
}

export function createBoundAgentCatalog(input: {
  store: AgentRevisionStore;
  defaultModel(): string | undefined;
  /** Host-owned routing/support checks, independent of source syntax compilation. */
  unavailableReasons(definition: CompiledAgentDefinition, model: string): string[];
}): BoundAgentCatalog {
  const { store } = input;
  const reasons = (definition: CompiledAgentDefinition, model: string): string[] => {
    const result = input.unavailableReasons(definition, model);
    if (
      definition.metadata.mode === "subagent" ||
      definition.metadata["user-invocable"] === false
    ) {
      return ["This Agent is unavailable for primary conversations", ...result];
    }
    return result;
  };
  const prepare = async (revision: AgentRevision) => {
    try {
      const configuration = await resolveAgentConfiguration({
        revision,
        store,
        defaultModel: input.defaultModel(),
      });
      return { configuration, unavailable: reasons(revision.definition, configuration.model) };
    } catch (error) {
      if (!(error instanceof AgentConfigurationError)) throw error;
      return { configuration: undefined, unavailable: [error.message] };
    }
  };
  const summarize = async (entry: AgentCatalogEntry): Promise<BoundAgentCatalogItem> => {
    const revision = await store.readRevision(entry.selectedRevisionId);
    if (!revision) throw new Error("Agent catalog references a missing revision");
    return {
      selection: { catalogEntryId: entry.id, definitionRevisionId: revision.id },
      slug: revision.slug,
      name: revision.definition.metadata.name ?? revision.slug,
      description: revision.definition.metadata.description ?? "",
      model: revision.definition.metadata.model ?? input.defaultModel() ?? null,
      ownership: entry.ownerUserId === null ? "system" : "personal",
      unavailableReasons: (await prepare(revision)).unavailable,
    };
  };
  return {
    async save(userId, source) {
      return store.withCatalogTransaction(userId, async () => {
        const existing = await store.readCatalogEntry(userId, source.slug);
        const coordinate = `personal/${source.slug}`;
        if (existing) {
          const previous = await store.readRevision(existing.selectedRevisionId);
          const retained = previous && (await store.readSource(previous.packageRevisionId));
          if (retained?.coordinate !== coordinate || existing.removed) {
            throw new AgentPublicationConflictError(
              `Agent "${source.slug}" belongs to another source or was removed.`,
            );
          }
        }
        if (
          existing &&
          source.expectedRevisionId !== undefined &&
          source.expectedRevisionId !== existing.selectedRevisionId
        ) {
          throw new AgentPublicationConflictError(
            "Agent changed since it was read; reload before saving.",
          );
        }
        const head = (await store.listInstallations(userId)).find(
          (item) => item.coordinate === coordinate,
        );
        const candidate = { coordinate, files: { [`agents/${source.slug}.md`]: source.content } };
        const installed = await store.installSource(candidate);
        if (
          existing &&
          source.expectedRevisionId === undefined &&
          existing.selectedRevisionId !== installed.definitions[0].id
        ) {
          throw new AgentPublicationConflictError(
            "Agent changed since it was read; reload before saving.",
          );
        }
        await publishAgentSource({
          store,
          ownerUserId: userId,
          source: candidate,
          expectedRevisionId: head?.currentRevisionId,
        });
        const selected = await store.readCatalogEntry(userId, source.slug);
        if (!selected) throw new Error("Published Agent missing from catalog");
        return summarize(selected);
      });
    },
    async installSystemSource(source) {
      return installSystemAgentSource(store, source);
    },
    async list(userId, page) {
      const entries = await store.listCatalog({ userId, ...page });
      const last = entries.at(-1);
      return {
        agents: await Promise.all(entries.map(summarize)),
        nextCursor:
          entries.length === page.limit && last
            ? { nameSortKey: last.nameSortKey, id: last.id }
            : null,
      };
    },
    async removeFromProject(userId, projectId, selection) {
      const resolved = await store.readSelection(
        userId,
        selection.catalogEntryId,
        selection.definitionRevisionId,
      );
      if (
        !resolved ||
        (resolved.entry.ownerUserId === null && resolved.entry.logicalKey === "general")
      )
        return false;
      await store.removeFromProject(projectId, resolved.entry.id);
      return true;
    },
    async resolvePrimary(userId, selection, projectId) {
      const resolved = await store.readSelection(
        userId,
        selection.catalogEntryId,
        selection.definitionRevisionId,
        projectId,
      );
      if (!resolved) return { ok: false, reason: "not-found", details: [] };
      const { configuration, unavailable } = await prepare(resolved.revision);
      if (!configuration || unavailable.length)
        return { ok: false, reason: "unavailable", details: unavailable };
      return {
        ok: true,
        revision: resolved.revision,
        configuration,
      };
    },
  };
}

/** Atomically publish trusted system definitions into the shared catalog. */
export async function installSystemAgentSource(
  store: AgentRevisionStore,
  source: AgentSourceSnapshot,
): Promise<void> {
  return store.withCatalogTransaction(null, async () => {
    const existing = (await store.listInstallations(null)).find(
      (item) => item.coordinate === source.coordinate,
    );
    const installed = await store.installSource(source);
    await publishAgentSource({
      store,
      ownerUserId: null,
      source,
      expectedRevisionId: existing?.currentRevisionId,
      upstreamRevisionId: installed.packageRevisionId,
    });
  });
}
