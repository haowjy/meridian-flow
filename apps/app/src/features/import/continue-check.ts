/**
 * Checks a new selection against a stored import before anything is sent, and
 * pairs its files with the stored ones afterwards. Roots are matched one to one
 * by what they hold (kind, name, every file's path and size, then digests), never
 * by order, so two `Notes.md` roots chosen the other way round still match and an
 * unchanged copy cannot stand in for a changed one. The first difference found is
 * the one the writer is told.
 */
import type { ImportEntryStatus, ImportManifest } from "@meridian/contracts";
import type { HeldFile } from "./manifest";
import type { Selection } from "./selection";

export type SelectionDifference = {
  kind: "changed" | "missing" | "extra" | "unreadable";
  name: string;
};

export type StoredImport = {
  roots: readonly { rootId: number; kind: "folder" | "file"; name: string }[];
  entries: Iterable<ImportEntryStatus>;
};

export type CheckOptions = {
  /**
   * The server is still planning and will resume only for the very same
   * selection, so a file left out at the start must still be left out.
   */
  exact?: boolean;
};

type StoredFile = { entryId: number; size: number; sha256: string };
type StoredRoot = {
  rootId: number;
  key: string;
  name: string;
  /** Files the import needs, by path. */
  files: Map<string, StoredFile>;
  /** Paths the reader could not open at the start; they were never part of the import. */
  leftOut: Set<string>;
};
type CandidateFile = { size: number; sha256?: string; entryId?: number };
type CandidateRoot = {
  rootId: number;
  key: string;
  name: string;
  files: Map<string, CandidateFile>;
  unreadable: Set<string>;
};

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const rootKey = (kind: string, name: string) => `${kind}\u0000${name}`;

function storedRoots(stored: StoredImport): StoredRoot[] {
  const roots = new Map<number, StoredRoot>(
    stored.roots.map((root) => [
      root.rootId,
      {
        rootId: root.rootId,
        key: rootKey(root.kind, root.name),
        name: root.name,
        files: new Map(),
        leftOut: new Set(),
      },
    ]),
  );
  for (const entry of stored.entries) {
    const root = roots.get(entry.rootId);
    if (!root) continue;
    if (entry.state === "skipped" && entry.reason === "unreadable") root.leftOut.add(entry.path);
    else
      root.files.set(entry.path, {
        entryId: entry.entryId,
        size: entry.size,
        sha256: entry.sha256,
      });
  }
  return [...roots.values()];
}

function fromSelection(selection: Selection): CandidateRoot[] {
  return selection.roots.map((root) => ({
    rootId: root.rootId,
    key: rootKey(root.kind, root.name),
    name: root.name,
    files: new Map(root.files.map(({ path, file }) => [path, { size: file.size }])),
    unreadable: new Set(root.unreadable.map((item) => item.path)),
  }));
}

function fromManifest(manifest: ImportManifest): CandidateRoot[] {
  const roots = new Map<number, CandidateRoot>(
    manifest.roots.map((root) => [
      root.rootId,
      {
        rootId: root.rootId,
        key: rootKey(root.kind, root.name),
        name: root.name,
        files: new Map(),
        unreadable: new Set(),
      },
    ]),
  );
  for (const entry of manifest.entries)
    roots.get(entry.rootId)?.files.set(entry.path, {
      size: entry.size,
      sha256: entry.sha256,
      entryId: entry.entryId,
    });
  for (const item of manifest.unreadable ?? []) roots.get(item.rootId)?.unreadable.add(item.path);
  return [...roots.values()];
}

/** Whether `path` is, or lies inside, something the reader left out at the start. */
function wasLeftOut(root: StoredRoot, path: string): boolean {
  for (let at = path; ; at = at.slice(0, at.lastIndexOf("/"))) {
    if (root.leftOut.has(at)) return true;
    if (!at.includes("/")) return false;
  }
}

/** The first way `candidate` is not `stored`'s root as it was chosen, or null. */
function compareRoot(
  stored: StoredRoot,
  candidate: CandidateRoot,
  digests: boolean,
  exact: boolean,
): SelectionDifference | null {
  const nameOf = (path: string) => lastSegment(path || stored.name);
  for (const [path, want] of stored.files) {
    if (candidate.unreadable.has(path)) return { kind: "unreadable", name: nameOf(path) };
    const have = candidate.files.get(path);
    if (!have) return { kind: "missing", name: nameOf(path) };
    if (have.size !== want.size || (digests && have.sha256 !== want.sha256))
      return { kind: "changed", name: nameOf(path) };
  }
  for (const path of candidate.files.keys()) {
    if (stored.files.has(path)) continue;
    // Left out at the start and readable now: not part of this import, unless the
    // server must see the very same selection again.
    if (wasLeftOut(stored, path)) {
      if (exact) return { kind: "changed", name: nameOf(path) };
      continue;
    }
    return { kind: "extra", name: nameOf(path) };
  }
  for (const path of candidate.unreadable) {
    if (stored.files.has(path) || wasLeftOut(stored, path)) continue;
    return { kind: "unreadable", name: nameOf(path) };
  }
  if (exact)
    for (const path of stored.leftOut)
      if (!candidate.unreadable.has(path)) return { kind: "missing", name: nameOf(path) };
  return null;
}

type RootMatch =
  | { kind: "match"; pairs: Map<number, CandidateRoot> }
  | { kind: "differs"; difference: SelectionDifference };

/**
 * One candidate per stored root, by content. Roots sharing a kind and name are
 * paired by augmenting paths, so an early pairing never steals a later root's
 * only match.
 */
function matchRoots(
  roots: readonly StoredRoot[],
  candidates: CandidateRoot[],
  digests: boolean,
  exact: boolean,
): RootMatch {
  const groups = new Map<string, CandidateRoot[]>();
  for (const candidate of candidates)
    groups.set(candidate.key, [...(groups.get(candidate.key) ?? []), candidate]);
  const known = new Map<string, SelectionDifference | null>();
  const differs = (root: StoredRoot, candidate: CandidateRoot) => {
    const at = `${root.rootId}:${candidate.rootId}`;
    if (!known.has(at)) known.set(at, compareRoot(root, candidate, digests, exact));
    return known.get(at) ?? null;
  };
  const owner = new Map<CandidateRoot, StoredRoot>();
  const claim = (root: StoredRoot, seen: Set<CandidateRoot>): boolean => {
    for (const candidate of groups.get(root.key) ?? []) {
      if (seen.has(candidate) || differs(root, candidate)) continue;
      seen.add(candidate);
      const holder = owner.get(candidate);
      if (!holder || claim(holder, seen)) {
        owner.set(candidate, root);
        return true;
      }
    }
    return false;
  };
  for (const root of roots) {
    if (claim(root, new Set())) continue;
    const first = groups.get(root.key)?.find((candidate) => !owner.has(candidate));
    const difference = first ? differs(root, first) : null;
    return { kind: "differs", difference: difference ?? { kind: "missing", name: root.name } };
  }
  const extra = candidates.find((candidate) => !owner.has(candidate));
  if (extra) return { kind: "differs", difference: { kind: "extra", name: extra.name } };
  const pairs = new Map<number, CandidateRoot>();
  for (const [candidate, root] of owner) pairs.set(root.rootId, candidate);
  return { kind: "match", pairs };
}

/** Before hashing: roots, files, paths and sizes. */
export function compareStructure(
  stored: StoredImport,
  selection: Selection,
  options: CheckOptions = {},
): SelectionDifference | null {
  const match = matchRoots(
    storedRoots(stored),
    fromSelection(selection),
    false,
    options.exact ?? false,
  );
  return match.kind === "differs" ? match.difference : null;
}

/** After hashing: every file the import needs has the same digest in the new manifest. */
export function compareDigests(
  stored: StoredImport,
  manifest: ImportManifest,
  options: CheckOptions = {},
): SelectionDifference | null {
  const match = matchRoots(
    storedRoots(stored),
    fromManifest(manifest),
    true,
    options.exact ?? false,
  );
  return match.kind === "differs" ? match.difference : null;
}

/**
 * Held files by the stored entry id they will be sent as. A resumed import
 * numbers its files afresh, so they pair by what they are, never by number or
 * order. Nothing is adopted from a selection that is not the stored one.
 */
export function matchHeld(
  stored: StoredImport,
  manifest: ImportManifest,
  held: ReadonlyMap<number, HeldFile>,
): Map<number, HeldFile> {
  const matched = new Map<number, HeldFile>();
  const roots = storedRoots(stored);
  const match = matchRoots(roots, fromManifest(manifest), true, false);
  if (match.kind === "differs") return matched;
  for (const root of roots) {
    const candidate = match.pairs.get(root.rootId);
    for (const [path, want] of root.files) {
      const entryId = candidate?.files.get(path)?.entryId;
      const file = entryId === undefined ? undefined : held.get(entryId);
      if (file) matched.set(want.entryId, file);
    }
  }
  return matched;
}

/** Files the continued import will send: the ones the server still waits for. */
export function outstanding(entries: Iterable<ImportEntryStatus>): number {
  let count = 0;
  for (const entry of entries) if (entry.wanted) count += 1;
  return count;
}
