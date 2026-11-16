/** Deterministic creation graph and placement derived only from durable import outcomes. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import { entrySegment, renderFilename } from "@meridian/contracts/protocol";
import { shownName, suffixesInArrival } from "@meridian/project-tree";
import type { ImportEntry, ImportRecord } from "../../ports/import-repository.js";
import type { ImportPlacement } from "../placement.js";
import { type PlannedNode, planWithDerivedIds } from "../plan.js";

export type DestinationSnapshot = {
  area: "manuscript" | "kb" | "unfiled";
  folderId: string | null;
  uri: string;
  fellBack: boolean;
  /** What the destination holds, by the names it shows (a document's carries its extension). */
  children: readonly { id: string; kind: "folder" | "file"; name: string }[];
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
 * the paths the stored text spells its links with stay the ones planned. Every node keeps its
 * name; one that meets a name already in its folder lands as a twin, and its path spells the
 * `~id` the replay will give it (it arrives after what the folder holds, in plan order).
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
  // Each folder's children in the order they arrive: what it holds, then the plan's nodes.
  const arrivals = new Map<string, { id: string; name: string }[]>();
  for (const destination of input.destinations)
    arrivals.set(
      parentKey(destination.area, destination.folderId),
      destination.children.map(({ id, name }) => ({ id, name })),
    );
  for (const node of nodes) {
    if (node.state === "planned" && node.kind === "folder" && node.area)
      arrivals.set(parentKey(node.area, node.id), []);
  }
  const topLevel = new Set<string>();
  for (const node of nodes) {
    if (node.state !== "planned" || !node.area) continue;
    if (!node.parentId || !plannedFolders.has(node.parentId)) {
      const destination = destinations.get(node.area);
      if (!destination) throw new Error(`Import tree has no destination for ${node.area}`);
      node.parentId = destination.folderId;
      topLevel.add(node.id);
    }
    const siblings = arrivals.get(parentKey(node.area, node.parentId));
    if (!siblings) throw new Error(`Import tree has no sibling group for ${node.id}`);
    // The name the node lands under: a converted document drops its source's extension.
    node.filename = renderFilename(node.name, node.kind === "folder" ? "" : node.extension);
    // The name the tree will store, as the replay compares it.
    const kind = node.kind === "folder" ? "folder" : node.kind === "binary" ? "file" : "document";
    siblings.push({ id: node.id, name: shownName(kind, node.filename, node.filetype) });
  }
  const suffixes = new Map(
    [...arrivals.values()].flatMap((siblings) => [...suffixesInArrival(siblings)]),
  );
  const topLevelSegments: Record<string, string> = {};
  for (const node of nodes) {
    if (node.state !== "planned") continue;
    const suffix = suffixes.get(node.id);
    const planned = topLevel.has(node.id) ? input.fixed?.topLevelSegments[node.id] : undefined;
    const segment = planned ?? entrySegment(node.filename, suffix);
    if (segment !== node.filename) node.segment = segment;
    if (topLevel.has(node.id)) topLevelSegments[node.id] = segment;
  }
  if (nodes.some((node) => node.state === "planned" && !node.area))
    throw new Error("Import tree has a node without an area");
  if (nodes.some((node) => node.state === "planned" && node.area && !destinations.has(node.area)))
    throw new Error("Import tree has no destination for an area");
  return {
    nodes,
    placement: {
      destinations: input.destinations.map(({ children: _, ...destination }) => destination),
      topLevelSegments,
    },
  };
}
