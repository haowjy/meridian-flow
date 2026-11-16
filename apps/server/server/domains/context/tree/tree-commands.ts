/**
 * The AI's tree commands, decided on one copy of the list under its lock (tree-tools.md): `create`
 * of a folder, `move` (rename, reorder, several at once), `delete` and `restore`. A path is
 * resolved through the names the model was shown, the operation is made for the node it meant
 * and carries only what the model changed, and the answer says what the call did and what the
 * model could not have known about the nodes it touched. Nothing here writes before it has
 * decided: a refusal makes no record.
 */
import { canonicalLeaf, type Filetype, storedFilename } from "@meridian/contracts/protocol";
import {
  type Actor,
  childrenOf,
  deleteCovering,
  descendantsOf,
  isSourceRoot,
  LIVE,
  listRecords,
  type MovePlace,
  type NodeKind,
  sourceIdOf,
  sourceRoot,
  type TrashEntry,
  type TreeNode,
  type TreeProjection,
  type TreeRecord,
  undoChange,
} from "@meridian/project-tree";
import type { TreeScope } from "../ports/context-adapter.js";
import {
  candidates,
  changeDelta,
  type NamesShown,
  pathNames,
  printedDelta,
  type Resolution,
  resolveShown,
  type ShownDelta,
  splitSegments,
} from "./names-shown.js";

export type Placement =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "before"; sibling: string }
  | { kind: "after"; sibling: string };

export type TreeCommand =
  | { command: "create"; path: string }
  | { command: "move"; from: readonly string[]; path: string; position?: Placement; many: boolean }
  | { command: "delete"; path: string }
  | { command: "restore"; path: string };

/** One record the call made, for the receipt: the node it acts on and the record's id. */
export type MadeRecord = { record: string; node: string };

/** A call that names nothing, or has nothing to make: the one refusal left. */
export type Refused = {
  ok: false;
  status: "invalid_write" | "document_not_found";
  path: string;
  message: string;
  /** A move of several that moved none: each source and why, as the message lists them. */
  notMoved?: string[];
  delta: ShownDelta;
};

export type LeftOut = { path: string; why: "would_loop" | "purged" };

export type Done = {
  ok: true;
  /** The node the receipt hangs on: the one acted on, or the folder several were moved into. */
  subject: string;
  made: MadeRecord[];
  /** Where the node landed, when that is not the path the call gave. */
  landed?: string;
  shownAt: string;
  landedAt: string;
  moved?: { made: number; of: number };
  notMoved: string[];
  /** How many documents and files a folder's delete took. */
  deleted?: number;
  /** Text after `kept:`. */
  kept?: string;
  placedAtEnd?: string;
  /** The call's end was already true: nothing was made. */
  already?: "deleted" | "at_destination" | "live";
  /** Nodes the call left alone: moving a folder into itself, or a node deleted for good. */
  leftOut?: LeftOut[];
  deletedInLive?: true;
  /** Changes by others to the nodes the call named, by author. */
  concurrent: Array<{ author: string; lines: string[] }>;
  /** Documents and files a delete took, for the Works whose drafts outlive it. */
  taken: string[];
  /** Documents now at a live address. */
  arrived: string[];
  /** Every node the call created, moved, renamed, deleted or restored, with its path before and after. */
  touched: TouchedNode[];
  delta: ShownDelta;
};

/** `before` is null for a node the call created, `after` for one it deleted. */
export type TouchedNode = {
  node: string;
  kind: NodeKind;
  before: string | null;
  after: string | null;
};

export type TreeResult = Refused | Done;

/** The words for who: every person is `the user` in v1, an agent is `agent`. */
export function labelOf(actor: Actor): string {
  if (actor.startsWith("user:")) return "the user";
  if (actor.startsWith("agent:")) return "agent";
  return "unattributed";
}

/** Where the command's paths are: each source's area and the top of its tree. */
export type Places = {
  /** The area of the source the command runs in. */
  area: string;
  /** The top of each area's tree, by area. */
  roots: ReadonlyMap<string, string>;
  /** The area a path names and the path below it; null when it names none. */
  locate(path: string): { area: string; rest: string } | null;
};

type Context = {
  scope: TreeScope;
  area: string;
  places: Places;
  shown: NamesShown;
  records: Map<string, TreeRecord>;
  made: MadeRecord[];
  concurrent: Map<string, string[]>;
};

const uriOf = (area: string, names: readonly string[], folder: boolean) =>
  `${area}${names.join("/")}${folder && names.length > 0 ? "/" : ""}`;

/** The area a node's source is addressed by. */
function areaOfNode(cx: Context, node: TreeNode): string {
  for (const [area, root] of cx.places.roots) if (root === sourceRoot(node.source)) return area;
  return cx.area;
}

const nodeUri = (cx: Context, projection: TreeProjection, node: TreeNode) =>
  uriOf(areaOfNode(cx, node), pathNames(projection, node.id), node.kind === "folder");

function actorOfRecord(cx: Context, id: string | undefined): Actor | undefined {
  return id === undefined ? undefined : cx.records.get(id)?.actor;
}

function noteConcurrent(cx: Context, actor: Actor | undefined, line: string) {
  if (actor === undefined || actor === cx.scope.actor) return;
  const label = labelOf(actor);
  cx.concurrent.set(label, [...(cx.concurrent.get(label) ?? []), line]);
}

/** Who deleted a node in Trash: the author of the delete in force that took it. */
function deleterOf(cx: Context, projection: TreeProjection, node: TreeNode): Actor | undefined {
  const entry = deleteCovering(projection, node.id);
  return actorOfRecord(cx, entry?.from ?? entry?.id);
}

const refuse = (status: Refused["status"], path: string, message: string): Refused => ({
  ok: false,
  status,
  path,
  message,
  delta: { whole: [], names: [] },
});

/** A call that made nothing and says why: the call's end was already true, or it left nodes out. */
function nothingDone(
  subject: string,
  shownAt: string,
  facts: Pick<Done, "already" | "leftOut" | "notMoved">,
): Done {
  return {
    ok: true,
    subject,
    made: [],
    shownAt,
    landedAt: shownAt,
    ...facts,
    concurrent: [],
    taken: [],
    arrived: [],
    touched: [],
    delta: { whole: [], names: [] },
  };
}

/** A refusal for a resolution that names no node. */
function unresolved(
  cx: Context,
  projection: TreeProjection,
  written: string,
  resolution: Exclude<Resolution, { kind: "node" | "purged" }>,
): Refused {
  const path = uriOfPath(cx, written);
  switch (resolution.kind) {
    case "not_a_folder":
      return refuse(
        "document_not_found",
        path,
        `${uriOf(cx.area, pathNames(projection, resolution.node.id), false)} is a document, not a folder.`,
      );
    case "missing":
    case "other_version":
      return refuse("document_not_found", path, "File not found.");
  }
}

const isFolderPath = (path: string) => path.endsWith("/");

/**
 * Whether one node's `move` goes into the folder `path` names, under its own name, or lands at
 * `path` itself, its name included: into for a document, and for a folder only when `path` names
 * another folder that exists. A copy between lists reads `path` by the same rule.
 */
export function movesInto(
  path: string,
  movingFolder: boolean,
  namesAnotherFolder: () => boolean,
): boolean {
  return isFolderPath(path) && (!movingFolder || namesAnotherFolder());
}

type Located = { segments: string[]; folder: boolean; area: string; root: string };

/** A path the model wrote, in the area and tree it names. */
function pathFrom(cx: Context, path: string): Located {
  const at = cx.places.locate(path);
  const area = at?.area ?? cx.area;
  return {
    ...splitSegments(at?.rest ?? path),
    area,
    root: cx.places.roots.get(area) ?? cx.scope.root,
  };
}

const uriOfPath = (cx: Context, path: string) => {
  const at = cx.places.locate(path);
  return at ? `${at.area}${at.rest}` : path;
};

/** What others did to a node since the model last saw its name and place, as the one line each. */
function noteChanges(
  cx: Context,
  projection: TreeProjection,
  node: TreeNode,
  written: { segments: readonly string[]; folder: boolean },
  writtenUri: string,
) {
  const writtenLeaf = written.segments[written.segments.length - 1] ?? "";
  const history = projection.history.get(node.id);
  const nowName = node.displayName;
  const sameName =
    nowName === writtenLeaf ||
    nowName === (written.folder ? writtenLeaf : canonicalLeaf(writtenLeaf));
  if (!sameName)
    noteConcurrent(
      cx,
      actorOfRecord(cx, history?.label.at(-1)?.id),
      `renamed: ${writtenUri} → ${nowName}`,
    );
  const writtenParent = written.segments.slice(0, -1);
  const nowParent = pathNames(projection, node.id).slice(0, -1);
  if (writtenParent.join("/") !== nowParent.join("/"))
    noteConcurrent(
      cx,
      actorOfRecord(cx, history?.place.at(-1)?.id),
      `moved: ${writtenUri} → ${uriOf(areaOfNode(cx, node), nowParent, true)}`,
    );
}

function remember(cx: Context, record: string, node: string) {
  cx.made.push({ record, node });
}

/** The folders of `segments` under `start`, made where they do not exist yet. */
function ensureFolders(
  cx: Context,
  start: string,
  segments: readonly string[],
  filled: Array<{ folder: string; name: string; node: string }>,
): string {
  let parent = start;
  for (const name of segments) {
    const created = cx.scope.writer.create(cx.scope.view, cx.scope.actor, {
      kind: "folder",
      name,
      parent,
    });
    remember(cx, created.id, created.node);
    const shown = cx.scope.writer.view(cx.scope.view).nodes.get(created.node);
    filled.push({ folder: parent, name: shown?.displayName ?? name, node: created.node });
    parent = created.node;
  }
  return parent;
}

/** Where a path's leaf goes, decided and not yet made: the folders still to create under `parent`. */
type Destination = {
  parent: string;
  missing: readonly string[];
  /** Folders along the path that are in Trash: the call is made and they stand. */
  trashed: TreeNode[];
  through: Array<{ folder: string; name: string; node: string }>;
};

/** The folder `folders` names, resolved through the map, with what is missing left to make. */
function destinationParent(
  cx: Context,
  to: Located,
  folders: readonly string[],
):
  | { kind: "found"; destination: Destination }
  | { kind: "refused"; refused: Refused }
  | { kind: "purged"; node: TreeNode } {
  const projection = cx.scope.writer.view(cx.scope.view);
  if (folders.length === 0)
    return {
      kind: "found",
      destination: { parent: to.root, missing: [], trashed: [], through: [] },
    };
  const found = resolveShown(projection, cx.shown, to.root, { segments: folders, folder: true });
  if (found.kind === "purged") return { kind: "purged", node: found.node };
  if (found.kind === "node") {
    if (found.node.kind !== "folder")
      return {
        kind: "refused",
        refused: refuse(
          "invalid_write",
          uriOf(to.area, folders, true),
          `${nodeUri(cx, projection, found.node)} is a document, not a folder.`,
        ),
      };
    return {
      kind: "found",
      destination: {
        parent: found.node.id,
        missing: [],
        trashed: found.trashed,
        through: found.along,
      },
    };
  }
  if (found.kind === "missing")
    return {
      kind: "found",
      destination: {
        parent: found.along.at(-1)?.node ?? to.root,
        missing: folders.slice(found.at),
        trashed: found.trashed,
        through: found.along,
      },
    };
  return {
    kind: "refused",
    refused: unresolved(cx, projection, uriOf(to.area, folders, true), found),
  };
}

/** Makes the folders a decided destination lacks, and returns the folder the leaf goes in. */
function makeDestination(
  cx: Context,
  destination: Destination,
  filled: Array<{ folder: string; name: string; node: string }>,
): string {
  return ensureFolders(cx, destination.parent, destination.missing, filled);
}

/** The sentence for folders a call went into that were deleted since: they stand, holding it. */
function keptTrashed(cx: Context, projection: TreeProjection, trashed: readonly TreeNode[]) {
  if (trashed.length === 0) return undefined;
  return trashed
    .map(
      (folder) =>
        `${nodeUri(cx, projection, folder)}, deleted by ${labelOf(deleterOf(cx, projection, folder) ?? "")} after you last listed it`,
    )
    .join("; ");
}

/**
 * Where a position puts the nodes moved into `parent`, and what to say when it puts them at the end
 * instead: its anchor left the folder, or is one of the nodes being moved. The anchor's name is
 * looked up in the destination folder.
 */
function placeFor(
  cx: Context,
  parent: string,
  moving: readonly string[],
  position: Placement | undefined,
): { place: MovePlace; atEnd?: string } {
  if (!position || position.kind === "end" || position.kind === "start")
    return { place: { kind: position?.kind ?? "end" } };
  const projection = cx.scope.writer.view(cx.scope.view);
  const written = pathFrom(cx, position.sibling);
  const name = written.segments.at(-1);
  const sibling =
    name === undefined
      ? undefined
      : resolveShown(projection, cx.shown, parent, { segments: [name], folder: written.folder });
  const anchor = sibling?.kind === "node" ? sibling.node : undefined;
  const uri = uriOfPath(cx, position.sibling);
  if (!anchor || anchor.parent !== parent || anchor.trashed)
    return { place: { kind: "end" }, atEnd: `${uri} is no longer in this folder` };
  if (moving.includes(anchor.id))
    return { place: { kind: "end" }, atEnd: `${uri} is itself being moved` };
  return { place: { kind: position.kind, siblingId: anchor.id } };
}

/** Whether `parent` is `node` or inside it: a move there would put a folder inside itself. */
function loops(projection: TreeProjection, node: TreeNode, parent: string): boolean {
  return (
    node.kind === "folder" &&
    (parent === node.id || descendantsOf(projection, node.id).includes(parent))
  );
}

/**
 * Says in `concurrent` who put the destination inside `node`, when the model's own path does not:
 * the folder directly under `node` on the way down to the destination is what someone moved in.
 */
function noteLoopCause(
  cx: Context,
  projection: TreeProjection,
  node: TreeNode,
  through: Array<{ folder: string; name: string; node: string }>,
  written: Located,
) {
  const chain: string[] = [];
  const target = through.at(-1)?.node;
  for (let at = target; at && at !== node.id; at = projection.nodes.get(at)?.parent)
    chain.unshift(at);
  const inside = chain[0] ? projection.nodes.get(chain[0]) : undefined;
  const along = through.findIndex((step) => step.node === inside?.id);
  // The model wrote the path through `node` itself: nobody else is the cause.
  if (!inside || through.some((step) => step.node === node.id) || along < 0) return;
  const named = uriOf(written.area, written.segments.slice(0, along + 1), true);
  noteConcurrent(
    cx,
    actorOfRecord(cx, projection.history.get(inside.id)?.place.at(-1)?.id),
    `moved: ${named} into ${nodeUri(cx, projection, node)}`,
  );
}

/** A move that made nothing: the node, and what is true of it. `notMoved` is the several-move line. */
type Skipped = {
  node?: string;
  notMoved?: string;
  already?: "at_destination";
  leftOut?: LeftOut;
};

/** A move decided: its notes are written and its destination folder made; its records follow. */
type Decided = {
  node: TreeNode;
  folder: string;
  /** Whether it needs a move record; a rename alone does not. */
  moves: boolean;
  rename?: { name: string; filetype?: Filetype };
  shownAt: string;
  toUri: string;
  oldParent: string;
  oldName: string;
  kept?: string;
};

/**
 * One node to move, rename or place. Everything that can stop it is decided before the first
 * record is made, so a move that does nothing stores nothing (and neither does a call whose
 * items all do nothing: `SourceTree.run` drops what a call without records made).
 */
function decideMove(
  cx: Context,
  from: string,
  to: Located,
  toUri: string,
  position: Placement | undefined,
  filled: Array<{ folder: string; name: string; node: string }>,
  viaMany: boolean,
):
  | { go: Decided; fail?: undefined; skip?: undefined }
  | { fail: Refused; go?: undefined; skip?: undefined }
  | { skip: Skipped; fail?: undefined; go?: undefined } {
  const { scope } = cx;
  const projection = scope.writer.view(scope.view);
  const source = pathFrom(cx, from);
  const found = resolveShown(projection, cx.shown, source.root, source);
  const fromUri = uriOfPath(cx, from);
  if (found.kind === "purged")
    return {
      skip: { node: found.node.id, leftOut: { path: fromUri, why: "purged" } },
    };
  if (found.kind !== "node") {
    const refused = unresolved(cx, projection, from, found);
    return viaMany ? { skip: { notMoved: `${fromUri} (not found)` } } : { fail: refused };
  }
  const node = found.node;
  const parent = destinationParent(cx, to, to.segments.slice(0, -1));
  if (parent.kind === "purged")
    return { skip: { node: node.id, leftOut: { path: fromUri, why: "purged" } } };
  if (parent.kind === "refused")
    return viaMany
      ? { skip: { notMoved: `${fromUri} (${parent.refused.status})` } }
      : { fail: parent.refused };
  const destination = parent.destination;
  if (loops(projection, node, destination.parent)) {
    noteLoopCause(cx, projection, node, destination.through, to);
    return { skip: { node: node.id, leftOut: { path: fromUri, why: "would_loop" } } };
  }

  const toLeaf = to.segments.at(-1);
  const typedFrom = source.segments.at(-1) ?? "";
  const keepsName =
    toLeaf === undefined ||
    (source.folder ? typedFrom : canonicalLeaf(typedFrom)) ===
      (to.folder ? toLeaf : canonicalLeaf(toLeaf));
  let name: string | undefined;
  let filetype: Filetype | null = null;
  if (!keepsName && toLeaf !== undefined) {
    if (node.kind === "folder") name = toLeaf;
    else {
      const ext = node.displayName.lastIndexOf(".");
      const parsed = storedFilename(toLeaf, {
        extension: ext > 0 ? node.displayName.slice(ext + 1).toLowerCase() : "",
        editable: node.kind === "document",
        filetype: node.filetype,
      });
      if (!parsed.ok)
        return viaMany
          ? { skip: { notMoved: `${fromUri} (${parsed.message})` } }
          : { fail: refuse("invalid_write", toUri, parsed.message) };
      name = parsed.name;
      filetype = parsed.filename.filetype;
    }
  }
  const sameParent = destination.missing.length === 0 && node.parent === destination.parent;
  if (sameParent && name === undefined && !position && !node.trashed)
    return {
      skip: { node: node.id, already: "at_destination", notMoved: `${fromUri} (already there)` },
    };

  // Decided: the records follow.
  noteChanges(cx, projection, node, source, fromUri);
  if (node.trashed)
    noteConcurrent(
      cx,
      deleterOf(cx, projection, node),
      `deleted: ${fromUri}; this move brought it back`,
    );
  const folder = makeDestination(cx, destination, filled);
  const kept = keptTrashed(cx, projection, destination.trashed);
  return {
    go: {
      node,
      folder,
      moves: !sameParent || position !== undefined || node.trashed,
      ...(name !== undefined
        ? {
            rename: {
              name,
              ...(filetype && filetype !== node.filetype ? { filetype } : {}),
            },
          }
        : {}),
      shownAt: from,
      toUri,
      oldParent: node.parent,
      oldName: node.displayName,
      ...(kept ? { kept } : {}),
    },
  };
}

/**
 * The records for decided moves into one folder: one `moveAll` at `place`, so several land
 * together in the order given, then any rename.
 */
function writeMoves(cx: Context, decided: readonly Decided[], folder: string, place: MovePlace) {
  const { scope } = cx;
  const moving = decided.filter((item) => item.moves).map((item) => item.node.id);
  if (moving.length > 0)
    for (const record of scope.writer.moveAll(scope.view, scope.actor, moving, folder, place))
      remember(cx, record.id, record.node);
  for (const item of decided) {
    if (!item.rename) continue;
    const record = scope.writer.rename(
      scope.view,
      scope.actor,
      item.node.id,
      item.rename.name,
      item.rename.filetype,
    );
    remember(cx, record.id, item.node.id);
  }
}

/** What a decided move did, once its records are written. */
function landed(
  cx: Context,
  item: Decided,
  filled: Array<{ folder: string; name: string; node: string }>,
  emptied: Array<{ folder: string; name: string }>,
): Done {
  const final = cx.scope.writer.view(cx.scope.view);
  const landedNode = final.nodes.get(item.node.id) as TreeNode;
  emptied.push({ folder: item.oldParent, name: item.oldName });
  filled.push({ folder: landedNode.parent, name: landedNode.displayName, node: item.node.id });
  const landedAt = nodeUri(cx, final, landedNode);
  return {
    ok: true,
    subject: item.node.id,
    made: [],
    shownAt: item.shownAt,
    landedAt,
    ...(landedAt !== item.toUri ? { landed: landedAt } : {}),
    ...(item.kept ? { kept: item.kept } : {}),
    ...(landedNode.keptByPending ? { deletedInLive: true as const } : {}),
    notMoved: [],
    concurrent: [],
    taken: [],
    arrived: item.node.kind === "folder" ? [] : [item.node.id],
    touched: [],
    delta: { whole: [], names: [] },
  };
}

/** What a path the model wrote reaches for a tool that is not a tree command. */
export type PathReach =
  | {
      kind: "node";
      /** `entries` is a folder's shown children, for the sentence that says what a path is. */
      node: { id: string; kind: TreeNode["kind"]; entries: number };
      uri: string;
      delta: ShownDelta;
      /** A destination's folders that were in Trash and stand again for the call, and who deleted them. */
      kept?: string;
    }
  /** The path names a node this view can't act on: in Trash (`by` deleted it), purged, or of the other version. */
  | { kind: "gone"; why: "deleted" | "purged" | "other_version"; by?: Actor }
  | { kind: "unresolved" };

/**
 * Resolves a path through the names shown, for the tools that read or write inside a document:
 * the live node it meant and where it is now; `gone` when the node it names is not available
 * here, so no caller looks the path up again and reaches whatever holds that name now; or nothing
 * when neither the map nor the tree holds a node for it. Only a name the model was shown means a
 * node in Trash: an unshown name means a standing node or nothing.
 *
 * A `destination` (the folder a create goes into) never answers `gone`: a folder the model was
 * shown that someone deleted since stands again around what the call makes (rule 3), and a purged
 * one or one of the other version falls to the tree, where the call makes a fresh folder.
 */
export function reachPath(
  scope: Pick<TreeScope, "writer" | "view" | "root">,
  area: string,
  shown: NamesShown,
  path: string,
  /** Undo names what was deleted by its old path: a node in Trash is the one it means. */
  options: { deleted?: boolean; destination?: boolean } = {},
): PathReach {
  const cx: Context = {
    scope: { ...scope, actor: "" },
    area,
    places: { area, roots: new Map([[area, scope.root]]), locate: () => null },
    shown,
    records: new Map(listRecords(scope.writer.doc).map((record) => [record.id, record])),
    made: [],
    concurrent: new Map(),
  };
  const projection = scope.writer.view(scope.view);
  const found = resolveShown(projection, shown, scope.root, pathFrom(cx, path));
  if (found.kind === "purged" || found.kind === "other_version")
    return options.destination ? { kind: "unresolved" } : { kind: "gone", why: found.kind };
  if (found.kind !== "node") return { kind: "unresolved" };
  if (!options.deleted && !options.destination && found.trashed.length > 0) {
    const by = deleterOf(cx, projection, found.node);
    return { kind: "gone", why: "deleted", ...(by ? { by } : {}) };
  }
  const kept = options.destination ? keptTrashed(cx, projection, found.trashed) : undefined;
  return {
    kind: "node",
    node: {
      id: found.node.id,
      kind: found.node.kind,
      entries: childrenOf(projection, found.node.id).length,
    },
    uri: nodeUri(cx, projection, found.node),
    delta: printedDelta(projection, [found.node.id]),
    ...(kept ? { kept } : {}),
  };
}

/**
 * Whether `folder` holds a node at `rest` (a path below it, through the names shown), in Trash
 * included: what an undo at an old address asks of a folder that moved from above it.
 */
export function folderHolds(
  scope: Pick<TreeScope, "writer" | "view">,
  shown: NamesShown,
): (folder: string, rest: string) => boolean {
  const projection = scope.writer.view(scope.view);
  return (folder, rest) =>
    resolveShown(projection, shown, folder, splitSegments(rest)).kind === "node";
}

/**
 * What stayed standing in a folder after a delete or an Undo took only what the model saw or
 * made: the folder with what is in it, and who put that there (the last record to set its place).
 */
function keptStanding(
  cx: Context,
  after: TreeProjection,
  folder: string,
  kept: readonly string[],
): string | undefined {
  const holder = after.nodes.get(folder);
  const first = kept[0];
  if (!holder || first === undefined) return undefined;
  const placer =
    actorOfRecord(cx, after.history.get(first)?.place.at(-1)?.id) ??
    after.nodes.get(first)?.createdBy;
  return `${nodeUri(cx, after, holder)} with ${kept
    .map((id) => nodeUri(cx, after, after.nodes.get(id) as TreeNode))
    .join(", ")}, added by ${labelOf(placer ?? "")} after you last listed it`;
}

/** The folder a several-move went into, now that the call has made it. */
function destinationNode(cx: Context, to: Located): string | undefined {
  const found = resolveShown(cx.scope.writer.view(cx.scope.view), cx.shown, to.root, {
    segments: to.segments,
    folder: true,
  });
  return found.kind === "node" ? found.node.id : undefined;
}

/** The path the node had in Trash, matched against what the model wrote for it. */
function pathMatches(
  projection: TreeProjection,
  node: TreeNode,
  path: { segments: readonly string[]; folder: boolean },
): boolean {
  if ((node.kind === "folder") !== path.folder) return false;
  const names = pathNames(projection, node.id);
  return (
    names.length === path.segments.length &&
    names.every((name, at) =>
      candidates(
        path.segments[at] as string,
        at === path.segments.length - 1,
        path.folder,
      ).includes(name),
    )
  );
}

/** One tree command on the copy under the lock. */
export function runTreeCommand(
  scope: TreeScope,
  places: Places,
  shown: NamesShown,
  command: TreeCommand,
): TreeResult {
  const cx: Context = {
    scope,
    area: places.area,
    places,
    shown,
    records: new Map(listRecords(scope.writer.doc).map((record) => [record.id, record])),
    made: [],
    concurrent: new Map(),
  };
  const projection = scope.writer.view(scope.view);
  const finish = (done: Done): Done => {
    const after = scope.writer.view(scope.view);
    return {
      ...done,
      made: cx.made,
      touched: touchedNodes(cx, projection, after),
      concurrent: [...cx.concurrent].map(([author, lines]) => ({ author, lines })),
    };
  };
  const filled: Array<{ folder: string; name: string; node: string }> = [];
  const emptied: Array<{ folder: string; name: string }> = [];

  switch (command.command) {
    case "create": {
      const path = pathFrom(cx, command.path);
      const leaf = path.segments.at(-1);
      if (leaf === undefined)
        return refuse("invalid_write", command.path, "A folder needs a name.");
      const found = resolveShown(projection, shown, path.root, path);
      // A folder that stands there is what the call asked for; a document there is kept and the
      // new folder is numbered beside it by the replay.
      if (found.kind === "node" && found.node.kind === "folder" && !found.node.trashed)
        return finish(nothingDone(found.node.id, command.path, { already: "live", notMoved: [] }));
      const parent = destinationParent(cx, path, path.segments.slice(0, -1));
      if (parent.kind === "purged")
        return finish(
          nothingDone(parent.node.id, command.path, {
            leftOut: [{ path: uriOfPath(cx, command.path), why: "purged" }],
            notMoved: [],
          }),
        );
      if (parent.kind === "refused") return parent.refused;
      const folder = makeDestination(cx, parent.destination, filled);
      const last = ensureFolders(cx, folder, [leaf], filled);
      const after = scope.writer.view(scope.view);
      const landedAt = nodeUri(cx, after, after.nodes.get(last) as TreeNode);
      const kept = keptTrashed(cx, projection, parent.destination.trashed);
      return finish({
        ok: true,
        subject: last,
        made: [],
        shownAt: command.path,
        landedAt,
        ...(landedAt !== uriOfPath(cx, command.path) ? { landed: landedAt } : {}),
        ...(kept ? { kept } : {}),
        notMoved: [],
        concurrent: [],
        taken: [],
        arrived: [],
        touched: [],
        delta: changeDelta([], filled),
      });
    }

    case "move": {
      const to = pathFrom(cx, command.path);
      const toUri = uriOfPath(cx, command.path);
      if (!command.many) {
        const from = command.from[0] as string;
        const fromPath = pathFrom(cx, from);
        const into = movesInto(command.path, fromPath.folder, () => {
          const there = resolveShown(projection, shown, to.root, to);
          const self = resolveShown(projection, shown, fromPath.root, fromPath);
          // The folder named is another folder: the same path with a position is a reorder.
          return (
            there.kind === "node" &&
            there.node.kind === "folder" &&
            !(self.kind === "node" && self.node.id === there.node.id)
          );
        });
        const leaf = fromPath.segments.at(-1) ?? "";
        const target: Located = into
          ? { ...to, segments: [...to.segments, leaf], folder: fromPath.folder }
          : to;
        const moved = decideMove(
          cx,
          from,
          target,
          into ? uriOf(to.area, target.segments, target.folder) : toUri,
          command.position,
          filled,
          false,
        );
        if (moved.skip)
          return finish(
            nothingDone(moved.skip.node as string, command.path, {
              ...(moved.skip.already ? { already: moved.skip.already } : {}),
              ...(moved.skip.leftOut ? { leftOut: [moved.skip.leftOut] } : {}),
              notMoved: [],
            }),
          );
        if (moved.fail) return moved.fail;
        const { place, atEnd } = placeFor(
          cx,
          moved.go.folder,
          [moved.go.node.id],
          command.position,
        );
        writeMoves(cx, [moved.go], moved.go.folder, place);
        return finish({
          ...landed(cx, moved.go, filled, emptied),
          ...(atEnd ? { placedAtEnd: atEnd } : {}),
          delta: changeDelta(emptied, filled),
        });
      }
      // Several into one folder: each on its own, what could be moved is moved.
      const folder = destinationParent(cx, to, to.segments);
      if (folder.kind === "purged")
        return finish(
          nothingDone(folder.node.id, command.path, {
            leftOut: command.from.map((from) => ({ path: uriOfPath(cx, from), why: "purged" })),
            notMoved: [],
          }),
        );
      if (folder.kind === "refused") return folder.refused;
      const notMoved: string[] = [];
      const leftOut: LeftOut[] = [];
      const decided: Decided[] = [];
      let nothingToMake: string | undefined;
      for (const from of command.from) {
        const fromPath = pathFrom(cx, from);
        const leaf = fromPath.segments.at(-1) ?? "";
        const item: Located = {
          ...to,
          segments: [...to.segments, leaf],
          folder: fromPath.folder,
        };
        const result = decideMove(
          cx,
          from,
          item,
          uriOf(to.area, item.segments, item.folder),
          command.position,
          filled,
          true,
        );
        if (result.skip) {
          if (result.skip.notMoved) notMoved.push(result.skip.notMoved);
          if (result.skip.leftOut) leftOut.push(result.skip.leftOut);
          nothingToMake ??= result.skip.node;
        } else if (result.go) {
          if (!decided.some((other) => other.node.id === result.go.node.id))
            decided.push(result.go);
        } else notMoved.push(`${uriOfPath(cx, from)} (${result.fail?.status})`);
      }
      const made = decided.length;
      // Every item shares the destination and the anchor: one placement, so they land in order.
      const into = decided[0]?.folder;
      let placedAtEnd: string | undefined;
      let deletedInLive = false;
      const arrived: string[] = [];
      if (into !== undefined) {
        const placed = placeFor(
          cx,
          into,
          decided.filter((item) => item.moves).map((item) => item.node.id),
          command.position,
        );
        placedAtEnd = placed.atEnd;
        writeMoves(cx, decided, into, placed.place);
        for (const item of decided) {
          const done = landed(cx, item, filled, emptied);
          deletedInLive ||= done.deletedInLive === true;
          arrived.push(...done.arrived);
        }
      }
      if (made === 0) {
        // Everything was already there or left out: the call is done. Anything else named nothing.
        if (nothingToMake !== undefined && notMoved.length + leftOut.length === command.from.length)
          return finish(nothingDone(nothingToMake, command.path, { notMoved, leftOut }));
        const none = [...notMoved, ...leftOut.map((left) => left.path)];
        return {
          ...refuse("invalid_write", toUri, `Nothing moved: ${none.join("; ")}`),
          notMoved: none,
        };
      }
      const kept = keptTrashed(cx, projection, folder.destination.trashed);
      return finish({
        ok: true,
        subject: destinationNode(cx, to) ?? (cx.made[0]?.node as string),
        made: [],
        shownAt: command.path,
        landedAt: uriOf(to.area, to.segments, true),
        moved: { made, of: command.from.length },
        notMoved,
        ...(leftOut.length > 0 ? { leftOut } : {}),
        ...(kept ? { kept } : {}),
        ...(placedAtEnd ? { placedAtEnd } : {}),
        ...(deletedInLive ? { deletedInLive: true as const } : {}),
        concurrent: [],
        taken: [],
        arrived,
        touched: [],
        delta: changeDelta(emptied, filled),
      });
    }

    case "delete": {
      const path = pathFrom(cx, command.path);
      const found = resolveShown(projection, shown, path.root, path);
      if (found.kind === "purged")
        return finish(
          nothingDone(found.node.id, command.path, {
            leftOut: [{ path: uriOfPath(cx, command.path), why: "purged" }],
            notMoved: [],
          }),
        );
      if (found.kind !== "node") return unresolved(cx, projection, command.path, found);
      if (found.node.trashed)
        return finish(
          nothingDone(found.node.id, command.path, { already: "deleted", notMoved: [] }),
        );
      const node = found.node;
      const writtenUri = uriOfPath(cx, command.path);
      noteChanges(cx, projection, node, path, writtenUri);
      // The delete takes what the model saw inside the folder: a name it was shown, or any name
      // inside a folder it never listed. What was added since stays and keeps the folder standing.
      const inside = descendantsOf(projection, node.id).filter(
        (id) => !projection.nodes.get(id)?.trashed,
      );
      const addedSince = new Set<string>();
      const wasShown = (id: string): boolean => {
        const parent = (projection.nodes.get(id) as TreeNode).parent;
        // A folder the model never listed is deleted whole; one it listed is deleted as listed.
        return (
          !shown.whole.has(parent) || [...(shown.names.get(parent)?.values() ?? [])].includes(id)
        );
      };
      for (const id of inside) {
        const child = projection.nodes.get(id) as TreeNode;
        if (addedSince.has(child.parent)) {
          addedSince.add(id);
          continue;
        }
        if (!wasShown(id)) addedSince.add(id);
      }
      const cascade = inside.filter((id) => !addedSince.has(id));
      const record = scope.writer.author(scope.view, scope.actor, {
        type: "delete",
        node: node.id,
        cascade,
      });
      remember(cx, record.id, node.id);
      const after = scope.writer.view(scope.view);
      const took = [node.id, ...cascade].filter(
        (id) =>
          (after.nodes.get(id)?.trashed ?? true) && projection.nodes.get(id)?.kind !== "folder",
      );
      const kept = [...addedSince].filter(
        (id) => !addedSince.has(after.nodes.get(id)?.parent ?? ""),
      );
      const keptNote = keptStanding(cx, after, node.id, kept);
      return finish({
        ok: true,
        subject: node.id,
        made: [],
        shownAt: command.path,
        landedAt: command.path,
        ...(node.kind === "folder" ? { deleted: took.length } : {}),
        ...(keptNote ? { kept: keptNote } : {}),
        ...(node.keptByPending ? { deletedInLive: true as const } : {}),
        notMoved: [],
        concurrent: [],
        taken: took,
        arrived: [],
        touched: [],
        delta: changeDelta([{ folder: node.parent, name: node.displayName }], []),
      });
    }

    case "restore": {
      const path = pathFrom(cx, command.path);
      // Source-qualified Trash entries, newest deletion first: a path in one source never
      // reaches another's node, and restoring again brings the next older one.
      const source = sourceIdOf(path.root);
      let target: TreeNode | undefined;
      let entry: TrashEntry | undefined;
      for (const candidate of [...projection.trash].reverse()) {
        const hit = [candidate.node, ...candidate.cascade]
          .map((id) => projection.nodes.get(id))
          .find((node) => node && node.source === source && pathMatches(projection, node, path));
        if (hit) {
          target = hit;
          entry = candidate.node === hit.id ? candidate : undefined;
          break;
        }
      }
      if (!target) {
        const live = resolveShown(projection, shown, path.root, path);
        return live.kind === "node"
          ? finish(nothingDone(live.node.id, command.path, { already: "live", notMoved: [] }))
          : refuse("document_not_found", command.path, "Nothing in Trash had that path.");
      }
      const node = target;
      const wasTrashedAbove: TreeNode[] = [];
      for (
        let at = projection.nodes.get(node.parent);
        at;
        at = isSourceRoot(at.parent) ? undefined : projection.nodes.get(at.parent)
      )
        if (at.trashed) wasTrashedAbove.push(at);
      const record = entry
        ? scope.writer.restoreEntry(scope.view, scope.actor, entry.from ?? entry.id)
        : scope.writer.restore(scope.view, scope.actor, node.id);
      // The entry came from this view's Trash, so its delete is in force.
      if (record === "unknown") throw new Error(`restore: no delete in force for ${node.id}`);
      remember(cx, record.id, node.id);
      const after = scope.writer.view(scope.view);
      const landedNode = after.nodes.get(node.id) as TreeNode;
      const landedAt = nodeUri(cx, after, landedNode);
      const keptFolders = wasTrashedAbove.filter(
        (folder) => after.nodes.get(folder.id)?.keptByChild,
      );
      return finish({
        ok: true,
        subject: node.id,
        made: [],
        shownAt: command.path,
        landedAt,
        ...(landedAt !== uriOfPath(cx, command.path) ? { landed: landedAt } : {}),
        ...(keptFolders.length > 0
          ? { kept: keptFolders.map((folder) => nodeUri(cx, after, folder)).join(", ") }
          : {}),
        notMoved: [],
        concurrent: [],
        taken: [],
        arrived: landedNode.kind === "folder" ? [] : [node.id],
        touched: [],
        delta: changeDelta(
          [],
          [{ folder: landedNode.parent, name: landedNode.displayName, node: node.id }],
        ),
      });
    }
  }
}

export type UndoneTree = {
  /** Records the package refused to take back: something changed that fact since. */
  outcomes: Array<"changed_since" | "purged" | "already" | "unknown">;
  made: MadeRecord[];
  /** Whether any opposite record is in live (a drafted change an Apply landed is taken back there). */
  inLive: boolean;
  landedAt: string;
  kept?: string;
  touched: TouchedNode[];
  delta: ShownDelta;
};

/**
 * Takes a receipt's records back, newest first, each by the package's `undoChange` (which finds
 * a record's copy after an Apply or a restored Discard). Only what the receipt did is taken back:
 * what others put in a folder it made stands, and keeps the folder standing.
 */
export function runTreeUndo(
  scope: TreeScope,
  places: Places,
  records: readonly MadeRecord[],
  subject: string,
  asked: string,
): UndoneTree {
  const cx: Context = {
    scope,
    area: places.area,
    places,
    shown: { whole: new Set(), names: new Map() },
    records: new Map(listRecords(scope.writer.doc).map((record) => [record.id, record])),
    made: [],
    concurrent: new Map(),
  };
  const before = scope.writer.view(scope.view);
  const outcomes: UndoneTree["outcomes"] = [];
  let inLive = scope.view.draft === null;
  for (const entry of [...records].reverse()) {
    const back = undoChange(scope.writer, scope.view, scope.actor, entry.record);
    if (typeof back === "string") outcomes.push(back);
    else {
      if (back.draft === null) inLive = true;
      remember(cx, back.id, entry.node);
    }
  }
  const after =
    scope.view.draft !== null && inLive ? scope.writer.view(LIVE) : scope.writer.view(scope.view);
  const touched = touchedNodes(cx, before, after);
  const standing = [...new Set(cx.made.map((made) => made.node))].flatMap((id) => {
    const node = after.nodes.get(id);
    if (!node?.keptByChild) return [];
    const children = childrenOf(after, id).map((child) => child.id);
    return children.length > 0 ? [{ id, children }] : [];
  });
  const here = after.nodes.get(subject);
  return {
    outcomes,
    made: cx.made,
    inLive,
    // A create taken back leaves its node in Trash: the answer names the path it was asked by.
    landedAt: here && !here.trashed ? nodeUri(cx, after, here) : asked,
    ...(standing[0] ? { kept: keptStanding(cx, after, standing[0].id, standing[0].children) } : {}),
    touched,
    delta: {
      whole: [],
      names: [
        ...touched.flatMap((t): Array<[string, string, string | null]> => {
          const was = before.nodes.get(t.node);
          return was ? [[was.parent, was.displayName, null]] : [];
        }),
        ...touched.flatMap((t): Array<[string, string, string | null]> => {
          const now = after.nodes.get(t.node);
          return now && !now.trashed ? [[now.parent, now.displayName, t.node]] : [];
        }),
      ],
    },
  };
}

/** Every node a call changed, with its path before and after, from the two views of the list. */
function touchedNodes(cx: Context, before: TreeProjection, after: TreeProjection): TouchedNode[] {
  const named = new Set(cx.made.map((made) => made.node));
  const touched: TouchedNode[] = [];
  for (const [id, node] of after.nodes) {
    const was = before.nodes.get(id);
    if (
      was &&
      !named.has(id) &&
      was.parent === node.parent &&
      was.displayName === node.displayName &&
      was.trashed === node.trashed
    )
      continue;
    touched.push({
      node: id,
      kind: node.kind,
      before: was && !was.trashed ? nodeUri(cx, before, was) : null,
      after: node.trashed ? null : nodeUri(cx, after, node),
    });
  }
  return touched;
}

export { LIVE };
