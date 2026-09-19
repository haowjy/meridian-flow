/** Hermetic revision storage with serialized, rollback-safe transactions for app composition. */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { InvocationOverlay, ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import { InMemoryTransactionOwner } from "../../../shared/in-memory-transaction.js";
import {
  type AgentSourceSnapshot,
  prepareAgentSourceRevision,
} from "../domain/agent-source-revision.js";
import type {
  AgentCatalogEntry,
  AgentPackageHistoryEntry,
  AgentPackageInstallation,
  AgentRevision,
  AgentRevisionStore,
} from "../ports/agent-revision-store.js";

type State = {
  projectRemovals: Map<string, boolean>;
  installations: Map<string, AgentPackageInstallation>;
  installationHistory: Map<string, AgentPackageHistoryEntry[]>;
  sources: Map<string, { digest: string; source: AgentSourceSnapshot }>;
  revisions: Map<string, AgentRevision>;
  catalog: Map<string, AgentCatalogEntry>;
  history: Map<string, Set<string>>;
  bindings: Map<
    string,
    {
      revisionId: string | null;
      configuration: ResolvedAgentConfiguration;
      invocationOverlay: InvocationOverlay | null;
    }
  >;
};
export interface InMemoryAgentRevisionStore extends AgentRevisionStore {
  boundAgent(threadId: string): {
    agentDefinitionRevisionId: string;
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
    installationHistory: transactionOwner.map(),
    sources: transactionOwner.map(),
    revisions: transactionOwner.map(),
    catalog: transactionOwner.map(),
    history: transactionOwner.map(),
    bindings: transactionOwner.map(),
  };
  const state = () => current;
  const copy = <T>(value: T): T => structuredClone(value);
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
    async readInstallationHistory(owner, id) {
      return state().installations.get(id)?.ownerUserId === owner
        ? copy(state().installationHistory.get(id) ?? [])
        : [];
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
        for (const id of [input.currentRevisionId, input.upstreamRevisionId]) {
          if (!state().sources.has(id))
            throw new Error("Installation references a missing source revision");
        }
        const row = { ...values, id: existing?.id ?? randomUUID() };
        state().installations.set(row.id, copy(row));
        const history = copy(state().installationHistory.get(row.id) ?? []);
        for (const packageRevisionId of [input.currentRevisionId, input.upstreamRevisionId]) {
          if (!history.some((item) => item.packageRevisionId === packageRevisionId))
            history.push({ packageRevisionId, createdAt: new Date().toISOString() });
        }
        state().installationHistory.set(row.id, history);
        return copy(row);
      });
    },
    boundAgent(id) {
      const revisionId = state().bindings.get(id)?.revisionId;
      const revision = revisionId ? state().revisions.get(revisionId) : undefined;
      return revision
        ? {
            agentDefinitionRevisionId: revision.id,
            agentName: revision.definition.metadata.name ?? revision.slug,
          }
        : null;
    },
    transaction: (operation) => transactionOwner.run(operation),
    withCatalogTransaction(_ownerUserId, operation) {
      return store.transaction(operation);
    },
    installSource(source) {
      const prepared = prepareAgentSourceRevision(source);
      return store.transaction(async () => {
        for (const dependency of Object.values(prepared.dependencies)) {
          if (!state().sources.has(dependency))
            throw new Error("Agent source references a missing dependency revision");
        }
        const existing = [...state().sources.entries()].find(
          ([, record]) =>
            record.source.coordinate === prepared.coordinate &&
            record.digest === prepared.contentDigest,
        );
        if (existing)
          return {
            packageRevisionId: existing[0],
            definitions: await store.readPackageDefinitions(existing[0]),
          };
        const packageRevisionId = randomUUID();
        state().sources.set(packageRevisionId, {
          digest: prepared.contentDigest,
          source: {
            coordinate: prepared.coordinate,
            files: prepared.source.files,
            dependencies: prepared.dependencies,
          },
        });
        for (const definition of prepared.definitions) {
          const id = randomUUID();
          state().revisions.set(id, { id, packageRevisionId, ...definition });
        }
        return {
          packageRevisionId,
          definitions: await store.readPackageDefinitions(packageRevisionId),
        };
      });
    },
    async readSource(id) {
      return copy(state().sources.get(id)?.source);
    },
    async readRevision(id) {
      return copy(state().revisions.get(id));
    },
    async readPackageDefinitions(id) {
      return copy(
        [...state().revisions.values()]
          .filter((revision) => revision.packageRevisionId === id)
          .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
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
        const name = target.definition.metadata.name ?? target.slug;
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
      const revision = state().revisions.get(revisionId);
      return revision ? copy({ entry, revision }) : undefined;
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
    restoreOwnedEntry(user, id, expectedRevisionId) {
      return store.transaction(async () => {
        const entry = state().catalog.get(id);
        if (
          !entry ||
          entry.ownerUserId !== user ||
          !entry.removed ||
          entry.selectedRevisionId !== expectedRevisionId
        )
          return false;
        state().catalog.set(id, { ...entry, removed: false });
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
        state().bindings.set(threadId, { revisionId, configuration, invocationOverlay });
        return true;
      });
    },
    async readThreadBinding(threadId) {
      const binding = state().bindings.get(threadId);
      if (!binding) return undefined;
      const revision =
        binding.revisionId !== null ? state().revisions.get(binding.revisionId) : undefined;
      return copy({
        revision: revision ?? null,
        configuration: binding.configuration,
        invocationOverlay: binding.invocationOverlay ?? null,
      });
    },
  };
  return store;
}
