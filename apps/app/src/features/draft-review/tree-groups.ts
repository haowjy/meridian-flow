import { t } from "@lingui/core/macro";
import {
  changedFolders,
  isSourceRoot,
  type LandingFault,
  landingFaults,
  type TreeProjection,
  type TreeRecord,
} from "@meridian/project-tree";

type FolderChange =
  | { kind: "new" }
  | { kind: "deleted" }
  | { kind: "changed"; was: string | null; moved: { into: string } | "top" | null };

export type ChangeGroup<T> = {
  folder: {
    id: string;
    name: string;
    change: FolderChange;
    fault: LandingFault | null;
    folders: string[];
  } | null;
  files: T[];
  inner: ChangeGroup<T>[];
};

export function groupFiles<T>(group: ChangeGroup<T>): T[] {
  return [...group.files, ...group.inner.flatMap(groupFiles)];
}

export function groupsOf<T>(groups: readonly ChangeGroup<T>[]): ChangeGroup<T>[] {
  return groups.flatMap((group) => [group, ...groupsOf(group.inner)]);
}

export type WorkTreeChanges = {
  work: Pick<TreeProjection, "nodes" | "skipped">;
  live: Pick<TreeProjection, "nodes">;
  pending: readonly TreeRecord[];
  faults: ReadonlyMap<string, LandingFault>;
  /** `changedFolders`: each is a row of the Changes list and one in the Work's review count. */
  folders: ReadonlySet<string>;
};

type ListChanges = {
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
    live: { nodes: new Map(lists.flatMap(({ live }) => [...live.nodes])) },
    pending: lists.flatMap(({ pending }) => pending),
    faults,
    folders,
  };
}

function folderChange(
  { work, live }: Pick<WorkTreeChanges, "work" | "live">,
  records: readonly TreeRecord[],
): FolderChange {
  if (records.some((record) => record.type === "create")) return { kind: "new" };
  if (records.at(-1)?.type === "delete") return { kind: "deleted" };
  // The name and place the Work's tree shows against live's. An Undo carries what its author's
  // copy showed, and sets nothing itself, so after one the trees say what changed.
  const node = records[0]?.node;
  const shown = node === undefined ? undefined : work.nodes.get(node);
  const before = node === undefined ? undefined : live.nodes.get(node);
  const lastUndo = records.findLastIndex((record) => record.undoes !== undefined);
  const move = records.findLast(
    (record, at) => record.type === "move" && record.undoes === undefined && at > lastUndo,
  );
  const was =
    (lastUndo >= 0 || records.some((record) => record.type === "rename")) &&
    before &&
    shown &&
    before.name !== shown.name
      ? before.name
      : null;
  // Where the Work sends it, which is not where it stands when the move cannot land.
  const into =
    move?.type === "move"
      ? move.parent
      : shown && shown.parent !== before?.parent
        ? shown.parent
        : undefined;
  return {
    kind: "changed",
    was,
    moved:
      into === undefined
        ? null
        : isSourceRoot(into)
          ? "top"
          : { into: work.nodes.get(into)?.name ?? "" },
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
  { work, live, pending, faults, folders }: WorkTreeChanges,
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
        name: work.nodes.get(id)?.name ?? "",
        change: folderChange({ work, live }, records),
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

export function landingFaultSentence(fault: LandingFault): string {
  switch (fault.kind) {
    case "inside-itself": {
      const { into } = fault;
      return t`Can't move into ${into}: it is inside this now.`;
    }
    case "gone":
      return t`Can't land: the folder it goes to is gone.`;
  }
}
