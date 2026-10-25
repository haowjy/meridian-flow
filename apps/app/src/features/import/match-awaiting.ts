/** Continue pairs only awaiting entries, never by picker enumeration order. */
import type { ImportDetail } from "@meridian/contracts";
import type { HeldFile } from "./manifest";
import type { Selection } from "./selection";

export function matchAwaiting(detail: ImportDetail, selection: Selection) {
  const held = new Map<number, HeldFile>();
  const awaiting = detail.entries.filter((entry) => entry.state === "awaiting");
  const candidates = selection.roots.flatMap((root) =>
    root.files.map((item) => ({ ...item, name: root.name, kind: root.kind })),
  );
  const roots = new Map(detail.roots.map((root) => [root.rootId, root]));
  const wrongRoot = !selection.roots.some((picked) =>
    detail.roots.some((root) => root.name === picked.name && root.kind === picked.kind),
  );
  const used = new Set<(typeof candidates)[number]>();
  for (const entry of awaiting) {
    const root = roots.get(entry.rootId)!;
    let matches = candidates.filter(
      (candidate) =>
        !used.has(candidate) &&
        candidate.name === root.name &&
        candidate.kind === root.kind &&
        candidate.path === entry.path,
    );
    const duplicate =
      awaiting.filter(
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
          awaiting.filter(
            (other) =>
              roots.get(other.rootId)?.name === root.name &&
              other.path === entry.path &&
              other.size === candidate.file.size &&
              other.modifiedAt === candidate.file.lastModified,
          ).length === 1,
      );
    }
    if (matches.length !== 1) continue;
    const candidate = matches[0];
    used.add(candidate);
    held.set(entry.entryId, {
      entryId: entry.entryId,
      rootId: entry.rootId,
      path: entry.path,
      file: candidate.file,
      changed:
        candidate.file.size !== entry.size || candidate.file.lastModified !== entry.modifiedAt,
    });
  }
  return {
    held,
    missing: awaiting.filter((entry) => !held.has(entry.entryId)).map((entry) => entry.entryId),
    wrongRoot,
  };
}
