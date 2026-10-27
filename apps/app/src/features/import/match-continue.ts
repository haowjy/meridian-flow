/**
 * Continue pairs entries by root name and path, never by picker enumeration
 * order. Entries whose bytes the server lacks are sent; entries it already
 * holds are compared by content hash so a re-picked copy can confirm or flag
 * them without sending anything twice.
 */
import type { ImportDetail } from "@meridian/contracts";
import type { HeldFile } from "./manifest";
import type { Selection } from "./selection";

/** A received entry whose re-picked file must be hashed against the receipt. */
export type PickedReceived = { entryId: number; file: File };

export function matchContinue(detail: ImportDetail, selection: Selection) {
  const held = new Map<number, HeldFile>();
  const received: PickedReceived[] = [];
  // Received entries matter too: the writer may re-pick after an edit or a copy.
  const entries = detail.entries.filter(
    (entry) => entry.state === "awaiting" || entry.state === "received",
  );
  const candidates = selection.roots.flatMap((root) =>
    root.files.map((item) => ({ ...item, name: root.name, kind: root.kind })),
  );
  const roots = new Map(detail.roots.map((root) => [root.rootId, root]));
  const wrongRoot = !selection.roots.some((picked) =>
    detail.roots.some((root) => root.name === picked.name && root.kind === picked.kind),
  );
  const used = new Set<(typeof candidates)[number]>();
  for (const entry of entries) {
    const root = roots.get(entry.rootId)!;
    let matches = candidates.filter(
      (candidate) =>
        !used.has(candidate) &&
        candidate.name === root.name &&
        candidate.kind === root.kind &&
        candidate.path === entry.path,
    );
    const duplicate =
      entries.filter(
        (other) =>
          roots.get(other.rootId)?.name === root.name &&
          roots.get(other.rootId)?.kind === root.kind &&
          other.path === entry.path,
      ).length > 1;
    if (matches.length > 1 || duplicate) {
      matches = matches.filter(
        (candidate) =>
          candidate.file.size === entry.size &&
          candidate.file.lastModified === entry.modifiedAt &&
          entries.filter(
            (other) =>
              roots.get(other.rootId)?.name === root.name &&
              roots.get(other.rootId)?.kind === root.kind &&
              other.path === entry.path &&
              other.size === candidate.file.size &&
              other.modifiedAt === candidate.file.lastModified,
          ).length === 1,
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
    } else if (
      changed ||
      entry.reason === "changed_after_pick" ||
      entry.reason === "changed_after_upload"
    ) {
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
