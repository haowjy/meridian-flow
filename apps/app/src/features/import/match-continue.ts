/**
 * Continue pairs entries by root name and path, never by picker enumeration
 * order. Entries whose bytes the server lacks are sent; entries it already
 * holds are compared by content hash so a re-picked copy can confirm or flag
 * them without sending anything twice. Both indexes are built in one pass, so
 * pairing stays linear in the import's size.
 */
import type { ImportDetail } from "@meridian/contracts";
import type { HeldFile } from "./manifest";
import type { Selection } from "./selection";

/** A received entry whose re-picked file must be hashed against the receipt. */
export type PickedReceived = { entryId: number; file: File };

const identity = (name: string, kind: string, path: string) => `${name}\0${kind}\0${path}`;

export function matchContinue(detail: ImportDetail, selection: Selection) {
  const held = new Map<number, HeldFile>();
  const received: PickedReceived[] = [];
  // Received entries matter too: the writer may re-pick after an edit or a copy.
  const entries = detail.entries.filter(
    (entry) => entry.state === "awaiting" || entry.state === "received",
  );
  const roots = new Map(detail.roots.map((root) => [root.rootId, root]));
  const entryIdentity = (entry: (typeof entries)[number]) => {
    const root = roots.get(entry.rootId)!;
    return identity(root.name, root.kind, entry.path);
  };
  const candidates = new Map<string, { file: File }[]>();
  for (const root of selection.roots)
    for (const item of root.files) {
      const key = identity(root.name, root.kind, item.path);
      const same = candidates.get(key);
      if (same) same.push(item);
      else candidates.set(key, [item]);
    }
  // How many entries share an identity, and an identity plus the pick's size and time.
  const sharing = new Map<string, number>();
  const stamped = new Map<string, number>();
  for (const entry of entries) {
    const key = entryIdentity(entry);
    const stamp = `${key}\0${entry.size}\0${entry.modifiedAt}`;
    sharing.set(key, (sharing.get(key) ?? 0) + 1);
    stamped.set(stamp, (stamped.get(stamp) ?? 0) + 1);
  }
  const pickedRoots = new Set(selection.roots.map((root) => `${root.name}\0${root.kind}`));
  const wrongRoot = !detail.roots.some((root) => pickedRoots.has(`${root.name}\0${root.kind}`));
  const used = new Set<{ file: File }>();
  for (const entry of entries) {
    const key = entryIdentity(entry);
    let matches = (candidates.get(key) ?? []).filter((candidate) => !used.has(candidate));
    if (matches.length > 1 || (sharing.get(key) ?? 0) > 1) {
      matches = matches.filter(
        (candidate) =>
          candidate.file.size === entry.size &&
          candidate.file.lastModified === entry.modifiedAt &&
          stamped.get(`${key}\0${candidate.file.size}\0${candidate.file.lastModified}`) === 1,
      );
    }
    if (matches.length !== 1) continue;
    const candidate = matches[0];
    used.add(candidate);
    const changed =
      candidate.file.size !== entry.size || candidate.file.lastModified !== entry.modifiedAt;
    if (entry.state === "awaiting") {
      held.set(entry.entryId, {
        entryId: entry.entryId,
        rootId: entry.rootId,
        path: entry.path,
        file: candidate.file,
        changed,
      });
    } else if (changed || entry.reason === "changed_after_pick" || entry.changedAfterUpload) {
      // Same size and time means the receipt still matches; anything else needs the hash.
      received.push({ entryId: entry.entryId, file: candidate.file });
    }
  }
  return {
    held,
    received,
    missing: entries
      .filter((entry) => entry.state === "awaiting" && !held.has(entry.entryId))
      .map((entry) => entry.entryId),
    wrongRoot,
  };
}
