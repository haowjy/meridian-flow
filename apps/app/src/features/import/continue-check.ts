/**
 * Checks a new selection against a stored import before anything is sent:
 * roots by kind and name, files by path and size, then digests of the files
 * that match. The first difference found is the one the writer is told.
 */
import type { ImportEntryReport, ImportManifest } from "@meridian/contracts";
import type { Selection } from "./selection";

export type SelectionDifference = {
  kind: "changed" | "missing" | "extra" | "unreadable";
  name: string;
};

type Stored = {
  roots: readonly { rootId: number; kind: "folder" | "file"; name: string }[];
  entries: Iterable<ImportEntryReport>;
};

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Entries the reader could not open at the time are not part of what must match. */
const required = (entry: ImportEntryReport) =>
  !(entry.state === "skipped" && entry.reason === "unreadable");

export function compareStructure(stored: Stored, selection: Selection): SelectionDifference | null {
  const unused = [...selection.roots];
  const matched = new Map<number, Selection["roots"][number]>();
  for (const root of stored.roots) {
    const index = unused.findIndex((c) => c.kind === root.kind && c.name === root.name);
    if (index < 0) return { kind: "missing", name: root.name };
    matched.set(root.rootId, unused.splice(index, 1)[0]);
  }
  if (unused[0]) return { kind: "extra", name: unused[0].name };
  const seen = new Map<number, Set<string>>();
  for (const entry of stored.entries) {
    if (!required(entry)) continue;
    const root = matched.get(entry.rootId);
    const name = lastSegment(entry.path || entry.filename);
    const file = root?.files.find((f) => f.path === entry.path);
    if (!root || !file) return { kind: "missing", name };
    if (file.file.size !== entry.size) return { kind: "changed", name };
    seen.set(entry.rootId, (seen.get(entry.rootId) ?? new Set()).add(entry.path));
  }
  for (const [rootId, root] of matched) {
    const extra = root.files.find((f) => !seen.get(rootId)?.has(f.path));
    if (extra) return { kind: "extra", name: lastSegment(extra.path || root.name) };
  }
  return null;
}

/** After hashing: every stored file must have the same digest in the new manifest. */
export function compareDigests(
  stored: Stored,
  manifest: ImportManifest,
): SelectionDifference | null {
  const names = new Map(manifest.roots.map((root) => [root.rootId, root.name]));
  const have = new Set(
    manifest.entries.map(
      (e) => `${names.get(e.rootId)}\u0000${e.path}\u0000${e.size}\u0000${e.sha256}`,
    ),
  );
  const storedNames = new Map(stored.roots.map((root) => [root.rootId, root.name]));
  for (const entry of stored.entries) {
    if (!required(entry)) continue;
    const key = `${storedNames.get(entry.rootId)}\u0000${entry.path}\u0000${entry.size}\u0000${entry.sha256}`;
    if (!have.has(key)) return { kind: "changed", name: lastSegment(entry.path || entry.filename) };
  }
  for (const entry of manifest.unreadable ?? []) {
    const name = lastSegment(entry.path || (names.get(entry.rootId) ?? ""));
    return { kind: "unreadable", name };
  }
  return null;
}

/** Files the continued import will send: the ones the server still waits for. */
export function outstanding(entries: Iterable<ImportEntryReport>): number {
  let count = 0;
  for (const entry of entries)
    if (entry.state === "planned" || entry.state === "failed") count += 1;
  return count;
}
