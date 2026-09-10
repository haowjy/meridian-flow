/** Deterministic in-memory catalog adapter for conformance and app composition. */
import type {
  CatalogChange,
  CatalogChanges,
  CatalogCommit,
  CatalogEntry,
  CatalogLookupRequest,
  CatalogScope,
  CatalogSnapshot,
} from "@meridian/contracts/protocol";
import { catalogScopeKey } from "@meridian/contracts/protocol";
import { type ContextCatalog, normalizeCatalogChangesLimit } from "../ports/context-catalog.js";

type State = {
  generation: string;
  revision: number;
  oldestRevision: number;
  entries: Map<string, CatalogEntry>;
  commits: CatalogCommit[];
};
type UnorderedCatalogChange = CatalogChange extends infer Change
  ? Change extends { ordinal: number }
    ? Omit<Change, "ordinal">
    : never
  : never;

export class InMemoryContextCatalog implements ContextCatalog {
  private readonly states = new Map<string, State>();

  constructor(private readonly retainedCommits = 1_000) {}

  private state(scope: CatalogScope): State {
    const key = catalogScopeKey(scope);
    let state = this.states.get(key);
    if (!state) {
      state = {
        generation: crypto.randomUUID(),
        revision: 0,
        oldestRevision: 1,
        entries: new Map(),
        commits: [],
      };
      this.states.set(key, state);
    }
    return state;
  }

  private cursor(scope: CatalogScope, revision: number): string {
    const state = this.state(scope);
    return `${catalogScopeKey(scope)}:${state.generation}:${revision}`;
  }

  /** Adapter test/fixture mutation seam; publishes one indivisible commit. */
  commit(scope: CatalogScope, changes: readonly UnorderedCatalogChange[]): CatalogCommit {
    const state = this.state(scope);
    const entries = new Map(state.entries);
    const ordered = changes.map((change, ordinal) => ({ ...change, ordinal })) as CatalogChange[];
    for (const change of ordered) {
      if (change.operation === "upsert") entries.set(change.entry.entryId, change.entry);
      else if (change.operation === "delete") entries.delete(change.entryId);
    }
    const revision = state.revision + 1;
    const commit: CatalogCommit = {
      eventId: crypto.randomUUID(),
      commitId: crypto.randomUUID(),
      firstRevision: String(revision),
      lastRevision: String(revision),
      changes: ordered,
    };
    state.entries = entries;
    state.revision = revision;
    state.commits.push(commit);
    while (state.commits.length > this.retainedCommits) state.commits.shift();
    state.oldestRevision = Number(state.commits[0]?.firstRevision ?? revision + 1);
    return commit;
  }

  async snapshot(scope: CatalogScope): Promise<CatalogSnapshot> {
    const state = this.state(scope);
    return {
      scope,
      generation: state.generation,
      headRevision: String(state.revision),
      cursor: this.cursor(scope, state.revision),
      entries: [...state.entries.values()],
    };
  }

  async changes(
    scope: CatalogScope,
    cursor: string,
    requestedLimit?: number,
  ): Promise<CatalogChanges> {
    const state = this.state(scope);
    const prefix = `${catalogScopeKey(scope)}:${state.generation}:`;
    if (!cursor.startsWith(prefix)) {
      return { kind: "reset-required", scope, reason: "scope_changed" };
    }
    const revision = Number(cursor.slice(prefix.length));
    if (!Number.isSafeInteger(revision) || revision > state.revision) {
      return { kind: "reset-required", scope, reason: "gap" };
    }
    if (revision < state.oldestRevision - 1) {
      return { kind: "reset-required", scope, reason: "expired" };
    }
    const remaining = state.commits.filter((commit) => Number(commit.firstRevision) > revision);
    const limit = normalizeCatalogChangesLimit(requestedLimit);
    const commits = remaining.slice(0, limit);
    const next = Number(commits.at(-1)?.lastRevision ?? revision);
    return {
      kind: "delta",
      scope,
      commits,
      nextCursor: this.cursor(scope, next),
      headRevision: String(state.revision),
      hasMore: remaining.length > commits.length,
    };
  }

  async children({ scope, parentId }: { scope: CatalogScope; parentId: string }) {
    const snapshot = await this.snapshot(scope);
    return {
      scope,
      parentId,
      entries: snapshot.entries.filter(
        (entry) =>
          (entry.kind === "folder" || entry.kind === "file") && entry.parentId === parentId,
      ),
      headRevision: snapshot.headRevision,
    };
  }

  async lookup(input: CatalogLookupRequest) {
    const snapshot = await this.snapshot(input.scope);
    return {
      entry:
        snapshot.entries.find((entry) =>
          input.entryId !== undefined
            ? entry.entryId === input.entryId
            : "uri" in entry && entry.uri === input.uri,
        ) ?? null,
      headRevision: snapshot.headRevision,
    };
  }
}
