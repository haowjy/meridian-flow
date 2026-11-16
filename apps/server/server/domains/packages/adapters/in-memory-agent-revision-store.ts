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
  LatestSave,
  PackageSave,
  SaveOwner,
} from "../ports/agent-revision-store.js";

type State = {
  sources: Map<string, { digest: string; source: AgentSourceSnapshot }>;
  revisions: Map<string, CatalogRevision>;
  /** In insertion order, which is the Save order. */
  saves: Map<string, PackageSave & { owner: string }>;
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
    saves: transactionOwner.map(),
    bindings: transactionOwner.map(),
  };
  const state = () => current;
  const ownerKey = (owner: SaveOwner) =>
    "userId" in owner ? `user:${owner.userId}` : `project:${owner.projectId}`;
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
    async settleSave(owner, folder, decide) {
      const latest = [...state().saves.values()]
        .filter((save) => save.owner === ownerKey(owner) && save.folder === folder)
        .pop();
      const { value, publish } = await decide(latest && copy(latest));
      return publish
        ? { value, row: await store.savePackage(owner, folder, publish.packageRevisionId, publish) }
        : { value };
    },
    async savePackage(owner, folder, packageRevisionId, metadata) {
      const digest = packageRevisionId
        ? (state().sources.get(packageRevisionId)?.digest ?? null)
        : null;
      const save = {
        id: randomUUID(),
        folder,
        packageRevisionId,
        contentDigest: digest,
        createdAt: new Date(),
        undoneSaveId: metadata?.undoneSaveId ?? null,
        savedBy: metadata?.savedBy ?? "writer",
        hasPrevious: [...state().saves.values()].some(
          (row) => row.owner === ownerKey(owner) && row.folder === folder,
        ),
      };
      state().saves.set(save.id, { ...save, owner: ownerKey(owner) });
      return copy(save);
    },
    async readSaved(owner) {
      const latest = new Map<string, LatestSave>();
      for (const { owner: by, ...save } of state().saves.values()) {
        if (by !== ownerKey(owner)) continue;
        const undone = latest.get(save.folder)?.undoneSaveIds ?? [];
        latest.set(save.folder, {
          ...save,
          undoneSaveIds: save.undoneSaveId ? [...undone, save.undoneSaveId] : undone,
        });
      }
      return copy([...latest.values()]);
    },
    async undoSave(owner, saveId, restore) {
      const rows = [...state().saves.values()].filter((save) => save.owner === ownerKey(owner));
      const index = rows.findIndex((save) => save.id === saveId);
      if (index < 0) return undefined;
      const same = rows.filter((save) => save.folder === rows[index].folder);
      const latest = same[same.length - 1];
      if (same.some((row) => row.undoneSaveId === saveId))
        return { current: copy(latest), undone: null, reason: "already-undone" };
      if (latest.id !== saveId)
        return { current: copy(latest), undone: null, reason: "later-save" };
      const before = same[same.length - 2];
      if (!before || latest.undoneSaveId)
        return { current: copy(latest), undone: null, reason: "not-undoable" };
      await restore(copy(latest), copy(before));
      return {
        current: await store.savePackage(owner, latest.folder, before.packageRevisionId, {
          undoneSaveId: saveId,
        }),
        undone: copy(latest),
      };
    },
    async readSavedRevision(userId, projectId, id) {
      const row = state().revisions.get(id);
      const saved =
        row &&
        [...state().saves.values()].some(
          (save) =>
            save.packageRevisionId === row.packageRevisionId &&
            (save.owner === ownerKey({ userId }) ||
              (projectId !== undefined && save.owner === ownerKey({ projectId }))),
        );
      return saved ? copy(row) : undefined;
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
    async replaceThreadBinding(threadId, revisionId, configuration, skillPins) {
      const binding = state().bindings.get(threadId);
      if (!binding) return false;
      state().bindings.set(threadId, {
        ...binding,
        revisionId,
        configuration: copy(configuration),
        invokedSkills: { ...binding.invokedSkills, ...copy(skillPins) },
      });
      return true;
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
