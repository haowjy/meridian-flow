/**
 * Where a Work's tree changes land, read from the Work's view of the list: the folders the Work
 * changes head the drafted documents under them (a reorganisation reads as one group), and a
 * change that cannot land says why, before Apply and after it, since what cannot land stays
 * pending. The server's draft list stays the list of documents; this only arranges it.
 */
import { t } from "@lingui/core/macro";
import {
  isSourceRoot,
  type SkipReason,
  type TreeProjection,
  type TreeRecord,
} from "@meridian/project-tree";

/** What the Work does to a folder it changes. */
export type FolderChange =
  | { kind: "new" }
  | { kind: "deleted" }
  /** `was`: the name before a rename. `moved`: into a folder by name, or `top` of its source. */
  | { kind: "changed"; was: string | null; moved: { into: string } | "top" | null };

/** Why a pending change cannot land: the replay skips it, or live deleted what it changes. */
export type LandingFault =
  | { kind: "inside-itself"; into: string }
  | { kind: "gone" }
  | { kind: "deleted-live" };

export type ChangeGroup<T> = {
  /** The changed folder heading the group; null for documents under no changed folder. */
  folder: {
    id: string;
    change: FolderChange;
    fault: LandingFault | null;
    /** Every changed folder the group takes: this one and the changed folders inside it. */
    folders: string[];
  } | null;
  files: T[];
};

const GONE: ReadonlySet<SkipReason> = new Set([
  "missing-node",
  "missing-parent",
  "parent-not-folder",
  "purged",
]);

/** Each node's fault among the Work's pending records. */
export function landingFaults(
  work: TreeProjection,
  pending: readonly TreeRecord[],
): Map<string, LandingFault> {
  const byId = new Map(pending.map((record) => [record.id, record]));
  const faults = new Map<string, LandingFault>();
  for (const { record: id, reason } of work.skipped) {
    const record = byId.get(id);
    if (!record) continue;
    if (reason === "cycle" && record.type === "move")
      faults.set(record.node, {
        kind: "inside-itself",
        into: work.nodes.get(record.parent)?.displayName ?? "",
      });
    else if (GONE.has(reason)) faults.set(record.node, { kind: "gone" });
  }
  for (const record of pending) {
    const node = work.nodes.get(record.node);
    if (node?.keptByPending && !faults.has(record.node))
      faults.set(record.node, { kind: "deleted-live" });
  }
  return faults;
}

function folderChange(work: TreeProjection, records: readonly TreeRecord[]): FolderChange {
  if (records.some((record) => record.type === "create")) return { kind: "new" };
  if (records.at(-1)?.type === "delete") return { kind: "deleted" };
  const renamed = records.find((record) => record.type === "rename");
  // Where the Work sends it, which is not where it stands when the move cannot land.
  const move = records.filter((record) => record.type === "move").at(-1);
  return {
    kind: "changed",
    was: renamed?.type === "rename" ? renamed.fromName : null,
    moved:
      move?.type !== "move"
        ? null
        : isSourceRoot(move.parent)
          ? "top"
          : { into: work.nodes.get(move.parent)?.displayName ?? "" },
  };
}

/**
 * The drafted documents arranged under the outermost folder the Work changes above each, in
 * the list's order; documents under none come first, ungrouped. A changed folder no drafted
 * document stands under (a rename alone), or whose change cannot land, is a group with no
 * files: what is inside it is not going where it goes.
 */
export function groupByChangedFolder<T extends { documentId: string }>(
  files: readonly T[],
  work: TreeProjection,
  pending: readonly TreeRecord[],
  faults: ReadonlyMap<string, LandingFault>,
): ChangeGroup<T>[] {
  const byFolder = new Map<string, TreeRecord[]>();
  for (const record of pending) {
    const node = work.nodes.get(record.node);
    const kind = node?.kind ?? (record.type === "create" ? record.kind : undefined);
    if (kind !== "folder") continue;
    byFolder.set(record.node, [...(byFolder.get(record.node) ?? []), record]);
  }
  const outermost = (documentId: string): string | null => {
    let found: string | null = null;
    let at = work.nodes.get(documentId)?.parent;
    for (let hops = 0; at && !isSourceRoot(at) && hops < 10_000; hops += 1) {
      if (byFolder.has(at) && !faults.has(at)) found = at;
      at = work.nodes.get(at)?.parent;
    }
    return found;
  };
  const loose: T[] = [];
  const grouped = new Map<string, T[]>();
  for (const file of files) {
    const folder = outermost(file.documentId);
    if (folder === null) loose.push(file);
    else grouped.set(folder, [...(grouped.get(folder) ?? []), file]);
  }
  const heads = [...byFolder.keys()].filter(
    (folder) => work.nodes.has(folder) && (faults.has(folder) || outermost(folder) === null),
  );
  return [
    ...(loose.length > 0 ? [{ folder: null, files: loose }] : []),
    ...heads.map((id) => ({
      folder: {
        id,
        change: folderChange(work, byFolder.get(id) ?? []),
        fault: faults.get(id) ?? null,
        folders: [id, ...[...byFolder.keys()].filter((inner) => outermost(inner) === id)],
      },
      files: grouped.get(id) ?? [],
    })),
  ];
}

/** "Can't move into Book One: it is inside this folder now." */
export function landingFaultSentence(fault: LandingFault): string {
  switch (fault.kind) {
    case "inside-itself": {
      const { into } = fault;
      return t`Can't move into ${into}: it is inside this now.`;
    }
    case "gone":
      return t`Can't land: the folder it goes to is gone.`;
    case "deleted-live":
      return t`Deleted in live. Restore it to keep this change.`;
  }
}
