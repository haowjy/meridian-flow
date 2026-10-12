/**
 * Pairs the files this tab holds with the entries the server stored, by what
 * they are (root name, path, size, digest) and never by number or order. A
 * resumed import numbers its files afresh.
 */
import type { ImportEntryReport, ImportManifest } from "@meridian/contracts";
import type { HeldFile } from "./manifest";

const key = (rootName: string, path: string, size: number, sha256: string) =>
  `${rootName}\u0000${path}\u0000${size}\u0000${sha256}`;

/** Held files by the stored entry id they will be sent as. */
export function matchHeld(
  stored: {
    roots: readonly { rootId: number; name: string }[];
    entries: Iterable<ImportEntryReport>;
  },
  manifest: ImportManifest,
  held: ReadonlyMap<number, HeldFile>,
): Map<number, HeldFile> {
  const rootNames = new Map(manifest.roots.map((root) => [root.rootId, root.name]));
  const pool = new Map<string, HeldFile[]>();
  for (const entry of manifest.entries) {
    const file = held.get(entry.entryId);
    if (!file) continue;
    const at = key(rootNames.get(entry.rootId) ?? "", entry.path, entry.size, entry.sha256);
    pool.set(at, [...(pool.get(at) ?? []), file]);
  }
  const storedNames = new Map(stored.roots.map((root) => [root.rootId, root.name]));
  const matched = new Map<number, HeldFile>();
  for (const entry of stored.entries) {
    const at = key(storedNames.get(entry.rootId) ?? "", entry.path, entry.size, entry.sha256);
    const file = pool.get(at)?.shift();
    if (file) matched.set(entry.entryId, file);
  }
  return matched;
}
