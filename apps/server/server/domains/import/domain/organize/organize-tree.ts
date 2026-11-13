/** Deterministic creation graph and placement derived only from durable import outcomes. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import { firstFreeName, renderFilename } from "@meridian/contracts/protocol";
import type { ImportEntry, ImportRecord } from "../../ports/import-repository.js";
import type { ImportPlacement } from "../placement.js";
import { type PlannedNode, planWithDerivedIds } from "../plan.js";

export type DestinationSnapshot = {
  area: "manuscript" | "kb" | "unfiled";
  folderId: string | null;
  uri: string;
  fellBack: boolean;
  /** What the destination holds, by the names it shows (a document's carries its extension). */
  children: readonly { kind: "folder" | "file"; name: string }[];
};

export type OrganizedTree = {
  nodes: PlannedNode[];
  placement: ImportPlacement;
};

function effectiveNode(node: PlannedNode, entries: ReadonlyMap<string, ImportEntry>): PlannedNode {
  const entry = entries.get(node.id);
  if (node.kind !== "docx" || !entry) return node;
  if (entry.reason === "kept_as_file")
    return {
      ...node,
      kind: "binary",
      filetype: "docx",
      extension: "docx",
      filename: `${node.name}.docx`,
    };
  return { ...node, kind: "note", filetype: "markdown" };
}

/**
 * The creation graph and the plan. The first pass plans against the destinations as they are and
 * the plan is kept on the import (`imports.placement`); later passes pass it back as `fixed`, so
 * the names the stored text spells its links with stay the ones planned.
 */
export async function buildOrganizedTree(input: {
  record: ImportRecord;
  entries: readonly ImportEntry[];
  destinations: readonly DestinationSnapshot[];
  fixed?: ImportPlacement;
}): Promise<OrganizedTree> {
  if (!input.record.projectId) throw new Error("Import project is unavailable");
  const parsed = parseContextUri(input.record.destinationUri);
  if (!parsed.ok) throw new Error("Import destination is invalid");
  const files = input.entries.flatMap((entry) =>
    entry.kind === "file" && entry.receipt && entry.state !== "failed"
      ? [{ entryId: entry.entryId, ...entry.selection, ...entry.receipt }]
      : [],
  );
  const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const nodes = (
    await planWithDerivedIds(
      {
        importId: input.record.id,
        destination: { folderUri: input.record.destinationUri },
        roots: input.record.roots,
        folders: input.entries.flatMap((entry) =>
          entry.kind === "folder"
            ? [{ rootId: entry.selection.rootId, path: entry.selection.path }]
            : [],
        ),
        unreadable: input.entries.flatMap((entry) =>
          entry.kind === "unreadable"
            ? [
                {
                  rootId: entry.selection.rootId,
                  path: entry.selection.path,
                  reason: entry.selection.reasonParams?.readReason,
                },
              ]
            : [],
        ),
        entries: files,
      },
      { projectId: input.record.projectId },
      input.record.folderId,
    )
  ).map((node) =>
    effectiveNode(
      { ...node, area: node.area ?? (parsed.value.scheme as DestinationSnapshot["area"]) },
      entriesById,
    ),
  );
  const plannedFolders = new Set(
    nodes.filter((node) => node.kind === "folder").map((node) => node.id),
  );
  const destinations = new Map(
    input.destinations.map((destination) => [destination.area, destination]),
  );
  const parentKey = (area: string, id: string | null) => JSON.stringify([area, id]);
  const occupied = new Map<string, Set<string>>();
  for (const destination of input.destinations) {
    occupied.set(
      parentKey(destination.area, destination.folderId),
      new Set(destination.children.map((child) => child.name)),
    );
  }
  for (const node of nodes) {
    if (node.state === "planned" && node.kind === "folder" && node.area)
      occupied.set(parentKey(node.area, node.id), new Set());
  }
  const topLevelNames: Record<string, string> = {};
  for (const node of nodes) {
    if (node.state !== "planned" || !node.area) continue;
    const topLevel = !node.parentId || !plannedFolders.has(node.parentId);
    if (topLevel) {
      const destination = destinations.get(node.area);
      if (!destination) throw new Error(`Import tree has no destination for ${node.area}`);
      node.parentId = destination.folderId;
    }
    const siblings = occupied.get(parentKey(node.area, node.parentId));
    if (!siblings) throw new Error(`Import tree has no sibling group for ${node.id}`);
    const planned = topLevel ? input.fixed?.topLevelNames[node.id] : undefined;
    const free =
      planned === undefined
        ? firstFreeName(node, siblings)
        : {
            name: planned,
            filename: renderFilename(planned, node.kind === "folder" ? "" : node.extension),
          };
    node.name = free.name;
    node.filename = free.filename;
    if (topLevel) topLevelNames[node.id] = node.name;
    siblings.add(free.filename);
  }
  if (nodes.some((node) => node.state === "planned" && !node.area))
    throw new Error("Import tree has a node without an area");
  if (nodes.some((node) => node.state === "planned" && node.area && !destinations.has(node.area)))
    throw new Error("Import tree has no destination for an area");
  return {
    nodes,
    placement: {
      destinations: input.destinations.map(({ children: _, ...destination }) => destination),
      topLevelNames,
    },
  };
}
