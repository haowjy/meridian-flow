/** Hermetic revision storage with serialized, rollback-safe transactions for app composition. */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  GENERIC_SUBAGENT_NAME,
  type InvocationOverlay,
  type ResolvedAgentConfiguration,
  type RetainedSkillReference,
} from "@meridian/contracts/agents";
import { InMemoryTransactionOwner } from "../../../shared/in-memory-transaction.js";
import { type AgentSourceSnapshot, compilePackage } from "../domain/compile-package.js";
import { agentRevisionId } from "../domain/helpers.js";
import { GRAMMAR_VERSION } from "../domain/mars.js";
import type {
  AgentRevision,
  AgentRevisionStore,
  CatalogRevision,
} from "../ports/agent-revision-store.js";

type State = {
  sources: Map<string, { digest: string; source: AgentSourceSnapshot }>;
  revisions: Map<string, CatalogRevision>;
  picks: Set<string>;
  bindings: Map<
    string,
    {
      revisionId: string | null;
      configuration: ResolvedAgentConfiguration;
      invocationOverlay: InvocationOverlay | null;
      invokedSkills: Record<string, RetainedSkillReference>;
    }
  >;
};
export interface InMemoryAgentRevisionStore extends AgentRevisionStore {
  boundAgent(threadId: string): {
    agentDefinitionRevisionId: string | null;
    agentName: string;
  } | null;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

export function createInMemoryAgentRevisionStore(input: {
  transactionOwner?: InMemoryTransactionOwner;
  threadExists(threadId: string): Promise<boolean>;
}): InMemoryAgentRevisionStore {
  const transactionOwner = input.transactionOwner ?? new InMemoryTransactionOwner();
  const current: State = {
    sources: transactionOwner.map(),
    revisions: transactionOwner.map(),
    picks: transactionOwner.set(),
    bindings: transactionOwner.map(),
  };
  const state = () => current;
  const copy = <T>(value: T): T => structuredClone(value);
  const available = (row: CatalogRevision | undefined): AgentRevision | undefined =>
    row?.definition
      ? {
          id: row.id,
          packageRevisionId: row.packageRevisionId,
          slug: row.slug,
          grammarVersion: row.grammarVersion,
          definition: row.definition,
        }
      : undefined;
  const store: InMemoryAgentRevisionStore = {
    boundAgent(id) {
      const binding = state().bindings.get(id);
      if (!binding) return null;
      if (binding.revisionId === null) {
        return { agentDefinitionRevisionId: null, agentName: GENERIC_SUBAGENT_NAME };
      }
      const revision = state().revisions.get(binding.revisionId);
      return revision ? { agentDefinitionRevisionId: revision.id, agentName: revision.name } : null;
    },
    transaction: (operation) => transactionOwner.run(operation),
    installSource(source, grammarVersion = GRAMMAR_VERSION) {
      const compiled = compilePackage(source, grammarVersion);
      return store.transaction(async () => {
        const existing = [...state().sources.entries()].find(
          ([, record]) =>
            record.source.coordinate === compiled.coordinate &&
            record.digest === compiled.contentDigest,
        );
        const packageRevisionId = existing?.[0] ?? randomUUID();
        if (!existing) {
          state().sources.set(packageRevisionId, {
            digest: compiled.contentDigest,
            source: { coordinate: compiled.coordinate, files: compiled.files },
          });
        }
        const rows = [...state().revisions.values()].filter(
          (row) =>
            row.packageRevisionId === packageRevisionId && row.grammarVersion === grammarVersion,
        );
        for (const agent of compiled.agents) {
          if (rows.some((row) => row.slug === agent.slug)) continue;
          const id = agentRevisionId(compiled, agent.slug, grammarVersion);
          state().revisions.set(id, { id, packageRevisionId, grammarVersion, ...agent });
        }
        return {
          packageRevisionId,
          definitions: await store.readPackageCatalogRevisions(packageRevisionId, grammarVersion),
        };
      });
    },
    async recordPicks(userId, revisionIds) {
      for (const id of revisionIds) state().picks.add(`${userId}:${id}`);
    },
    async readPickedRevision(userId, id) {
      return state().picks.has(`${userId}:${id}`) ? copy(state().revisions.get(id)) : undefined;
    },
    async readSource(id) {
      return copy(state().sources.get(id)?.source);
    },
    async readCatalogRevision(id) {
      return copy(state().revisions.get(id));
    },
    async readRevision(id) {
      return copy(available(state().revisions.get(id)));
    },
    async readPackageCatalogRevisions(id, grammarVersion) {
      return copy(
        [...state().revisions.values()]
          .filter((row) => row.packageRevisionId === id && row.grammarVersion === grammarVersion)
          .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
      );
    },
    async readPackageDefinitions(id, grammarVersion) {
      return (await store.readPackageCatalogRevisions(id, grammarVersion)).flatMap(
        (row) => available(row) ?? [],
      );
    },
    bindThread(threadId, revisionId, configuration, invocationOverlay) {
      return store.transaction(async () => {
        if (
          (revisionId !== null && !state().revisions.has(revisionId)) ||
          !(await input.threadExists(threadId))
        )
          throw new Error("Agent binding references a missing thread or revision");
        const existing = state().bindings.get(threadId);
        if (existing)
          return (
            existing.revisionId === revisionId &&
            isDeepStrictEqual(existing.configuration, configuration) &&
            isDeepStrictEqual(existing.invocationOverlay, invocationOverlay)
          );
        state().bindings.set(threadId, {
          revisionId,
          configuration,
          invocationOverlay,
          invokedSkills: {},
        });
        return true;
      });
    },
    async readThreadBinding(threadId) {
      const binding = state().bindings.get(threadId);
      if (!binding) return undefined;
      const row =
        binding.revisionId !== null ? state().revisions.get(binding.revisionId) : undefined;
      const revision = available(row);
      if (row && !revision) {
        throw new Error(`Thread ${threadId} is bound to an Agent revision with no definition`);
      }
      return copy({
        revision: revision ?? null,
        configuration: binding.configuration,
        invocationOverlay: binding.invocationOverlay ?? null,
        invokedSkills: binding.invokedSkills,
      });
    },
    async recordInvokedSkill(threadId, slug, reference) {
      const binding = state().bindings.get(threadId);
      if (!binding) return false;
      state().bindings.set(threadId, {
        ...binding,
        invokedSkills: { ...binding.invokedSkills, [slug]: copy(reference) },
      });
      return true;
    },
  };
  return store;
}
