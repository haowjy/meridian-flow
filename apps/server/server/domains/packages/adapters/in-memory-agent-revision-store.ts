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
import { GRAMMAR_VERSION } from "../domain/mars.js";
import type {
  AgentCatalogEntry,
  AgentPackageInstallation,
  AgentRevision,
  AgentRevisionStore,
  CatalogRevision,
} from "../ports/agent-revision-store.js";

type State = {
  projectRemovals: Map<string, boolean>;
  installations: Map<string, AgentPackageInstallation>;
  sources: Map<string, { digest: string; source: AgentSourceSnapshot }>;
  revisions: Map<string, CatalogRevision>;
  catalog: Map<string, AgentCatalogEntry>;
  history: Map<string, Set<string>>;
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
    projectRemovals: transactionOwner.map(),
    installations: transactionOwner.map(),
    sources: transactionOwner.map(),
    revisions: transactionOwner.map(),
    catalog: transactionOwner.map(),
    history: transactionOwner.map(),
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
  const findEntry = (ownerUserId: string | null, logicalKey: string) =>
    [...state().catalog.values()].find(
      (entry) => entry.ownerUserId === ownerUserId && entry.logicalKey === logicalKey,
    );

  const store: InMemoryAgentRevisionStore = {
    async listInstallations(owner) {
      return copy(
        [...state().installations.values()]
          .filter((item) => item.ownerUserId === owner)
          .sort((a, b) => a.coordinate.localeCompare(b.coordinate)),
      );
    },
    async listInstallationsWithoutRows(grammarVersion) {
      return copy(
        [...state().installations.values()]
          .filter(
            (item) =>
              ![...state().revisions.values()].some(
                (row) =>
                  row.packageRevisionId === item.currentRevisionId &&
                  row.grammarVersion === grammarVersion,
              ),
          )
          .sort((a, b) => a.coordinate.localeCompare(b.coordinate)),
      );
    },
    async advanceInstallation(input) {
      return store.transaction(async () => {
        const { expectedRevisionId, ...values } = input;
        const existing = [...state().installations.values()].find(
          (item) => item.ownerUserId === input.ownerUserId && item.coordinate === input.coordinate,
        );
        if (
          existing
            ? existing.currentRevisionId !== expectedRevisionId
            : expectedRevisionId !== undefined
        )
          return undefined;
        if (!state().sources.has(input.currentRevisionId))
          throw new Error("Installation references a missing source revision");
        const row = { ...values, id: existing?.id ?? randomUUID() };
        state().installations.set(row.id, copy(row));
        return copy(row);
      });
    },
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
    withCatalogTransaction(_ownerUserId, operation) {
      return store.transaction(operation);
    },
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
          const id = randomUUID();
          state().revisions.set(id, { id, packageRevisionId, grammarVersion, ...agent });
        }
        return {
          packageRevisionId,
          definitions: await store.readPackageCatalogRevisions(packageRevisionId, grammarVersion),
        };
      });
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
    selectRevision(selection) {
      return store.transaction(async () => {
        const target = state().revisions.get(selection.revisionId);
        if (!target) return { ok: false, reason: "not-found" };
        const existing = findEntry(selection.ownerUserId, selection.logicalKey);
        if (selection.expectedRevisionId !== undefined) {
          if (
            !existing ||
            existing.removed ||
            existing.selectedRevisionId !== selection.expectedRevisionId
          )
            return { ok: false, reason: "conflict" };
          const history = new Set(state().history.get(existing.id));
          history.add(existing.selectedRevisionId);
          state().history.set(existing.id, history);
        } else if (existing) {
          return !existing.removed && existing.selectedRevisionId === target.id
            ? { ok: true, entry: copy(existing) }
            : { ok: false, reason: "conflict" };
        }
        const { name } = target;
        const entry: AgentCatalogEntry = {
          id: existing?.id ?? randomUUID(),
          ownerUserId: selection.ownerUserId,
          logicalKey: selection.logicalKey,
          selectedRevisionId: target.id,
          name,
          nameSortKey: name.normalize("NFC").toLowerCase(),
          removed: false,
        };
        state().catalog.set(entry.id, entry);
        return { ok: true, entry: copy(entry) };
      });
    },
    async readCatalogEntry(owner, key) {
      return copy(findEntry(owner, key));
    },
    async readSelection(user, entryId, revisionId, projectId) {
      if (projectId && state().projectRemovals.has(`${projectId}:${entryId}`)) return undefined;
      const entry = state().catalog.get(entryId);
      if (!entry || entry.removed || (entry.ownerUserId !== null && entry.ownerUserId !== user))
        return undefined;
      if (entry.selectedRevisionId !== revisionId && !state().history.get(entryId)?.has(revisionId))
        return undefined;
      let revision = state().revisions.get(revisionId);
      if (revision && revision.grammarVersion !== GRAMMAR_VERSION)
        revision = state().revisions.get(entry.selectedRevisionId);
      return revision && revision.grammarVersion === GRAMMAR_VERSION
        ? copy({ entry, revision })
        : undefined;
    },
    async listCatalog(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        throw new Error("Agent catalog limit must be between 1 and 100");
      const compare = (
        a: { nameSortKey: string; id: string },
        b: { nameSortKey: string; id: string },
      ) =>
        a.nameSortKey < b.nameSortKey
          ? -1
          : a.nameSortKey > b.nameSortKey
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0;
      return copy(
        [...state().catalog.values()]
          .filter(
            (entry) =>
              !entry.removed &&
              (!input.projectId ||
                !state().projectRemovals.has(`${input.projectId}:${entry.id}`)) &&
              (entry.ownerUserId === null || entry.ownerUserId === input.userId) &&
              (!input.after || compare(entry, input.after) > 0),
          )
          .sort(compare)
          .slice(0, input.limit),
      );
    },
    async removeFromProject(projectId, entryId) {
      state().projectRemovals.set(`${projectId}:${entryId}`, true);
    },
    removeOwnedEntry(user, id) {
      return store.transaction(async () => {
        const entry = state().catalog.get(id);
        if (!entry || entry.ownerUserId !== user || entry.removed) return false;
        state().catalog.set(id, { ...entry, removed: true });
        return true;
      });
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
