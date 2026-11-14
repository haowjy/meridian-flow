/**
 * Where a Work's tree changes land, read from the Work's view of the list: the folders the Work
 * changes head the drafted documents under them (a reorganisation reads as one group), and a
 * change that cannot land says why, before Apply and after it, since what cannot land stays
 * pending. The server's draft list stays the list of documents; this only arranges it.
 */
import { t } from "@lingui/core/macro";
import {
  changedFolders,
  isSourceRoot,
  type LandingFault,
  landingFaults,
  type TreeProjection,
  type TreeRecord,
} from "@meridian/project-tree";

/** What the Work does to a folder it changes. */
export type FolderChange =
  | { kind: "new" }
  | { kind: "deleted" }
  /** `was`: the name before a rename. `moved`: into a folder by name, or `top` of its source. */
  | { kind: "changed"; was: string | null; moved: { into: string } | "top" | null };

export type ChangeGroup<T> = {
  /** The changed folder heading the group; null for documents under no changed folder. */
  folder: {
    id: string;
    /** The Work's view's name for it, a deleted folder's included. */
    name: string;
    change: FolderChange;
    fault: LandingFault | null;
    /** Every changed folder the group takes: this one and the changed folders inside it. */
    folders: string[];
  } | null;
  /** The documents whose nearest changed folder is this one. */
  files: T[];
  /** The changed folders inside this one, each a row of its own under it. */
  inner: ChangeGroup<T>[];
};

/** The group's documents, then those of the folders inside it: the order its rows show. */
export function groupFiles<T>(group: ChangeGroup<T>): T[] {
  return [...group.files, ...group.inner.flatMap(groupFiles)];
}

/** The group and the groups inside it, in the order their rows show. */
export function groupsOf<T>(groups: readonly ChangeGroup<T>[]): ChangeGroup<T>[] {
  return groups.flatMap((group) => [group, ...groupsOf(group.inner)]);
}

/**
 * A Work's tree changes across the lists its branch spans (its project's and its owner's
 * account list): the nodes of its views, its pending records, what cannot land, and the folders
 * it changes.
 */
export type WorkTreeChanges = {
  work: Pick<TreeProjection, "nodes" | "skipped">;
  pending: readonly TreeRecord[];
  faults: ReadonlyMap<string, LandingFault>;
  /** `changedFolders`: each is a row of the Changes list and one in the Work's review count. */
  folders: ReadonlySet<string>;
};

/** One list's replays: live, the Work's view of it, and the Work's pending records in it. */
export type ListChanges = {
  live: TreeProjection;
  work: TreeProjection;
  pending: readonly TreeRecord[];
};

export function workTreeChanges(lists: readonly ListChanges[]): WorkTreeChanges {
  const faults = new Map<string, LandingFault>();
  const folders = new Set<string>();
  for (const { live, work, pending } of lists) {
    const found = landingFaults(work, pending);
    for (const [node, fault] of found) faults.set(node, fault);
    for (const folder of changedFolders(live, work, pending, found)) folders.add(folder);
  }
  // Node ids are unique across lists, so the views' nodes read as one.
  return {
    work: {
      nodes: new Map(lists.flatMap(({ work }) => [...work.nodes])),
      skipped: lists.flatMap(({ work }) => work.skipped),
    },
    pending: lists.flatMap(({ pending }) => pending),
    faults,
    folders,
  };
}

function folderChange(work: WorkTreeChanges["work"], records: readonly TreeRecord[]): FolderChange {
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
 * The drafted documents arranged under the nearest folder the Work changes above each, those
 * folders nested in the changed folder above them, in the list's order; documents under none
 * come first, ungrouped. A changed folder no drafted document stands under (a rename alone), or
 * whose change cannot land, is a group with no files: what is inside it is not going where it
 * goes. A folder that cannot land stays a top-level group with its reason.
 */
export function groupByChangedFolder<T extends { documentId: string }>(
  files: readonly T[],
  { work, pending, faults, folders }: WorkTreeChanges,
): ChangeGroup<T>[] {
  const byFolder = new Map<string, TreeRecord[]>();
  for (const record of pending) {
    if (!folders.has(record.node)) continue;
    byFolder.set(record.node, [...(byFolder.get(record.node) ?? []), record]);
  }
  const nearest = (from: string | undefined): string | null => {
    let at = from;
    for (let hops = 0; at && !isSourceRoot(at) && hops < 10_000; hops += 1) {
      if (byFolder.has(at) && !faults.has(at)) return at;
      at = work.nodes.get(at)?.parent;
    }
    return null;
  };
  const groups = new Map<string, ChangeGroup<T>>();
  for (const [id, records] of byFolder)
    groups.set(id, {
      folder: {
        id,
        name: work.nodes.get(id)?.displayName ?? "",
        change: folderChange(work, records),
        fault: faults.get(id) ?? null,
        folders: [id],
      },
      files: [],
      inner: [],
    });
  const loose: T[] = [];
  for (const file of files) {
    const home = nearest(work.nodes.get(file.documentId)?.parent);
    if (home === null) loose.push(file);
    else groups.get(home)?.files.push(file);
  }
  const heads: ChangeGroup<T>[] = [];
  for (const [id, group] of groups) {
    const above = faults.has(id) ? null : nearest(work.nodes.get(id)?.parent);
    if (above === null) heads.push(group);
    else groups.get(above)?.inner.push(group);
  }
  // Each group takes the folders inside it along, deepest first.
  const gather = (group: ChangeGroup<T>): string[] => {
    const inside = group.inner.flatMap(gather);
    if (group.folder) group.folder.folders = [group.folder.id, ...inside];
    return group.folder?.folders ?? inside;
  };
  for (const head of heads) gather(head);
  return [...(loose.length > 0 ? [{ folder: null, files: loose, inner: [] }] : []), ...heads];
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
