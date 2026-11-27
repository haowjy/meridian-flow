import {
  canonicalLeaf,
  entryExtension,
  type Filetype,
  readSegment,
  storedFilename,
} from "@meridian/contracts/protocol";
import {
  type Actor,
  changeUndone,
  childrenOf,
  deleteCovering,
  descendantsOf,
  isSourceRoot,
  LIVE,
  listRecords,
  type MovePlace,
  type NodeKind,
  segmentOf,
  settledRecords,
  sourceIdOf,
  sourceRoot,
  type TakenBack,
  type TrashEntry,
  type TreeNode,
  type TreeProjection,
  type TreeRecord,
  takeBackAll,
  type UndoAnswer,
} from "@meridian/project-tree";
import { type ClosedSource, closedAnswer, type TreeJudge } from "../../../shared/tree-owners.js";
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

export type MadeRecord = { record: string; node: string };

export type Refused = {
  ok: false;
  status: "invalid_write" | "document_not_found";
  path: string;
  message: string;
  notMoved?: string[];
  delta: ShownDelta;
};

export type LeftOut = { path: string; why: "would_loop" | "purged" };

export type Done = {
  ok: true;
  subject: string;
  made: MadeRecord[];
  landed?: string;
  shownAt: string;
  landedAt: string;
  moved?: { made: number; of: number };
  notMoved: string[];
  deleted?: number;
  kept?: string;
  placedAtEnd?: string;
  already?: "deleted" | "at_destination" | "live";
  leftOut?: LeftOut[];
  concurrent: Array<{ author: string; lines: string[] }>;
  taken: string[];
  arrived: string[];
  touched: TouchedNode[];
  delta: ShownDelta;
};

export type TouchedNode = {
  node: string;
  kind: NodeKind;
  before: string | null;
  after: string | null;
};

export type TreeResult = Refused | Done;

export function labelOf(actor: Actor): string {
  if (actor.startsWith("user:")) return "the user";
  if (actor.startsWith("agent:")) return "agent";
  return "unattributed";
}

export type Places = {
  area: string;
  roots: ReadonlyMap<string, string>;
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

export function movesInto(
  path: string,
  movingFolder: boolean,
  namesAnotherFolder: () => boolean,
): boolean {
  return isFolderPath(path) && (!movingFolder || namesAnotherFolder());
}

type Located = { segments: string[]; folder: boolean; area: string; root: string };

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

const nameOf = (segment: string) => readSegment(segment).name;

function noteChanges(
  cx: Context,
  projection: TreeProjection,
  node: TreeNode,
  written: { segments: readonly string[]; folder: boolean },
  writtenUri: string,
) {
  const writtenLeaf = written.segments[written.segments.length - 1] ?? "";
  const history = projection.history.get(node.id);
  const sameName =
    node.name === nameOf(writtenLeaf) ||
    node.name === nameOf(written.folder ? writtenLeaf : canonicalLeaf(writtenLeaf));
  if (!sameName)
    noteConcurrent(
      cx,
      actorOfRecord(cx, history?.label.at(-1)?.id),
      `renamed: ${writtenUri} → ${segmentOf(node)}`,
    );
  const writtenParent = written.segments.slice(0, -1).map(nameOf);
  const nowParent = pathNames(projection, node.id).slice(0, -1);
  if (writtenParent.join("/") !== nowParent.map(nameOf).join("/"))
    noteConcurrent(
      cx,
      actorOfRecord(cx, history?.place.at(-1)?.id),
      `moved: ${writtenUri} → ${uriOf(areaOfNode(cx, node), nowParent, true)}`,
    );
}

function remember(cx: Context, record: string, node: string) {
  cx.made.push({ record, node });
}

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
      name: readSegment(name).name,
      parent,
    });
    remember(cx, created.id, created.node);
    const shown = cx.scope.writer.view(cx.scope.view).nodes.get(created.node);
    filled.push({ folder: parent, name: shown ? segmentOf(shown) : name, node: created.node });
    parent = created.node;
  }
  return parent;
}

type Destination = {
  parent: string;
  missing: readonly string[];
  trashed: TreeNode[];
  through: Array<{ folder: string; name: string; node: string }>;
};

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

function makeDestination(
  cx: Context,
  destination: Destination,
  filled: Array<{ folder: string; name: string; node: string }>,
): string {
  return ensureFolders(cx, destination.parent, destination.missing, filled);
}

function keptTrashed(cx: Context, projection: TreeProjection, trashed: readonly TreeNode[]) {
  if (trashed.length === 0) return undefined;
  return trashed
    .map(
      (folder) =>
        `${nodeUri(cx, projection, folder)}, deleted by ${labelOf(deleterOf(cx, projection, folder) ?? "")} after you last listed it`,
    )
    .join("; ");
}

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

function carrierOf<T>(
  projection: TreeProjection,
  node: string,
  named: ReadonlyMap<string, T>,
): T | undefined {
  for (let at = projection.nodes.get(node)?.parent; at; at = projection.nodes.get(at)?.parent) {
    const carrier = named.get(at);
    if (carrier) return carrier;
  }
  return undefined;
}

function loops(projection: TreeProjection, node: TreeNode, parent: string): boolean {
  return (
    node.kind === "folder" &&
    (parent === node.id || descendantsOf(projection, node.id).includes(parent))
  );
}

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
  if (!inside || through.some((step) => step.node === node.id) || along < 0) return;
  const named = uriOf(written.area, written.segments.slice(0, along + 1), true);
  noteConcurrent(
    cx,
    actorOfRecord(cx, projection.history.get(inside.id)?.place.at(-1)?.id),
    `moved: ${named} into ${nodeUri(cx, projection, node)}`,
  );
}

type Skipped = {
  node?: string;
  notMoved?: string;
  already?: "at_destination";
  leftOut?: LeftOut;
};

type Decided = {
  node: TreeNode;
  folder: string;
  moves: boolean;
  rename?: { name: string; filetype?: Filetype };
  shownAt: string;
  toUri: string;
  oldParent: string;
  oldName: string;
  kept?: string;
};

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
    nameOf(source.folder ? typedFrom : canonicalLeaf(typedFrom)) ===
      nameOf(to.folder ? toLeaf : canonicalLeaf(toLeaf));
  let name: string | undefined;
  let filetype: Filetype | null = null;
  if (!keepsName && toLeaf !== undefined) {
    if (node.kind === "folder") name = nameOf(toLeaf);
    else {
      const parsed = storedFilename(nameOf(toLeaf), {
        extension: entryExtension(node),
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
      oldName: segmentOf(node),
      ...(kept ? { kept } : {}),
    },
  };
}

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

function landed(
  cx: Context,
  item: Decided,
  filled: Array<{ folder: string; name: string; node: string }>,
  emptied: Array<{ folder: string; name: string }>,
): Done {
  const final = cx.scope.writer.view(cx.scope.view);
  const landedNode = final.nodes.get(item.node.id) as TreeNode;
  emptied.push({ folder: item.oldParent, name: item.oldName });
  filled.push({ folder: landedNode.parent, name: segmentOf(landedNode), node: item.node.id });
  const landedAt = nodeUri(cx, final, landedNode);
  return {
    ok: true,
    subject: item.node.id,
    made: [],
    shownAt: item.shownAt,
    landedAt,
    ...(landedAt !== item.toUri ? { landed: landedAt } : {}),
    ...(item.kept ? { kept: item.kept } : {}),
    notMoved: [],
    concurrent: [],
    taken: [],
    arrived: item.node.kind === "folder" ? [] : [item.node.id],
    touched: [],
    delta: { whole: [], names: [] },
  };
}

export type PathReach =
  | {
      kind: "node";
      node: { id: string; kind: TreeNode["kind"]; entries: number };
      uri: string;
      delta: ShownDelta;
      kept?: string;
    }
  | { kind: "gone"; why: "deleted" | "purged" | "other_version"; by?: Actor }
  | { kind: "unresolved" };

export function reachPath(
  scope: Pick<TreeScope, "writer" | "view" | "root">,
  area: string,
  shown: NamesShown,
  path: string,
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

export function folderHolds(
  scope: Pick<TreeScope, "writer" | "view">,
  shown: NamesShown,
): (folder: string, rest: string) => boolean {
  const projection = scope.writer.view(scope.view);
  return (folder, rest) =>
    resolveShown(projection, shown, folder, splitSegments(rest)).kind === "node";
}

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
        shownAt: landedAt,
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
      const going: Decided[] = [];
      const named = new Map<string, { from: string; goes: boolean }>();
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
          if (result.skip.node && !named.has(result.skip.node))
            named.set(result.skip.node, { from, goes: false });
        } else if (result.go) {
          going.push(result.go);
          if (!named.has(result.go.node.id)) named.set(result.go.node.id, { from, goes: true });
        } else notMoved.push(`${uriOfPath(cx, from)} (${result.fail?.status})`);
      }
      // As the sidebar's `outermost`: a node named twice, or inside a folder also named, moves once,
      // with that folder; it counts as moved when the folder does.
      const decided: Decided[] = [];
      let made = 0;
      for (const item of going) {
        const carrier = carrierOf(projection, item.node.id, named);
        if (carrier && !carrier.goes) {
          notMoved.push(`${uriOfPath(cx, item.shownAt)} (inside ${uriOfPath(cx, carrier.from)})`);
          continue;
        }
        made += 1;
        if (!carrier && !decided.some((other) => other.node.id === item.node.id))
          decided.push(item);
      }
      const into = decided[0]?.folder;
      let placedAtEnd: string | undefined;
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
          arrived.push(...landed(cx, item, filled, emptied).arrived);
        }
      }
      if (made === 0) {
        if (nothingToMake !== undefined && notMoved.length + leftOut.length === command.from.length)
          return finish(nothingDone(nothingToMake, command.path, { notMoved, leftOut }));
        const none = [...notMoved, ...leftOut.map((left) => left.path)];
        return {
          ...refuse("invalid_write", toUri, `Nothing moved: ${none.join("; ")}`),
          notMoved: none,
        };
      }
      const kept = keptTrashed(cx, projection, folder.destination.trashed);
      const after = cx.scope.writer.view(cx.scope.view);
      const movedNode = decided[0]?.node.id as string;
      const folderNode = after.nodes.get((after.nodes.get(movedNode) as TreeNode).parent);
      const subject = folderNode ? folderNode.id : movedNode;
      const landedAt = folderNode ? nodeUri(cx, after, folderNode) : uriOf(to.area, [], true);
      return finish({
        ok: true,
        subject,
        made: [],
        shownAt: landedAt,
        landedAt,
        moved: { made, of: command.from.length },
        notMoved,
        ...(leftOut.length > 0 ? { leftOut } : {}),
        ...(kept ? { kept } : {}),
        ...(placedAtEnd ? { placedAtEnd } : {}),
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
      const inside = descendantsOf(projection, node.id).filter(
        (id) => !projection.nodes.get(id)?.trashed,
      );
      const addedSince = new Set<string>();
      const wasShown = (id: string): boolean => {
        const parent = (projection.nodes.get(id) as TreeNode).parent;
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
        notMoved: [],
        concurrent: [],
        taken: took,
        arrived: [],
        touched: [],
        delta: changeDelta([{ folder: node.parent, name: segmentOf(node) }], []),
      });
    }

    case "restore": {
      const path = pathFrom(cx, command.path);
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
          [{ folder: landedNode.parent, name: segmentOf(landedNode), node: node.id }],
        ),
      });
    }
  }
}

export type UndoneTree = {
  fate: ReturnType<typeof changeUndone> | "discarded";
  closed?: ClosedSource;
  partial: boolean;
  made: MadeRecord[];
  inLive: boolean;
  landedAt: string;
  kept?: string;
  touched: TouchedNode[];
  delta: ShownDelta;
};

export function runTreeUndo(
  scope: TreeScope,
  places: Places,
  records: readonly MadeRecord[],
  subject: string,
  asked: string,
  judge: TreeJudge,
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
  const answers: UndoAnswer[] = [];
  let inLive = scope.view.draft === null;
  let closed: ClosedSource | undefined;
  const newestFirst = [...records].reverse();
  const walked = takeBackAll(
    scope.writer,
    scope.actor,
    newestFirst.map((entry) => ({ id: entry.record, view: scope.view })),
    judge.closed,
  );
  for (const entry of newestFirst) {
    const back = walked.get(entry.record) as TakenBack;
    if (typeof back === "string") answers.push(back);
    else if ("closed" in back) {
      answers.push(closedAnswer(judge, back.closed));
      const fate = judge.fate(back.closed);
      if (fate?.kind === "closed") closed ??= fate;
    } else {
      answers.push("undoes");
      if (back.draft === null) inLive = true;
      remember(cx, back.id, entry.node);
    }
  }
  judge.assertLocked();
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
  const stayed = changeUndone(answers.filter((answer) => answer !== "undoes"));
  const fate = changeUndone(answers);
  const settled = settledRecords(scope.writer.doc);
  const discarded = records.every((entry) => {
    const was = settled.get(entry.record)?.fate;
    return was === "discarded" || was === "dropped";
  });
  return {
    fate: fate === "taken" && discarded ? "discarded" : fate,
    ...(closed ? { closed } : {}),
    partial: cx.made.length > 0 && stayed !== "taken",
    made: cx.made,
    inLive,
    landedAt: here && !here.trashed ? nodeUri(cx, after, here) : asked,
    ...(standing[0] ? { kept: keptStanding(cx, after, standing[0].id, standing[0].children) } : {}),
    touched,
    delta: {
      whole: [],
      names: [
        ...touched.flatMap((t): Array<[string, string, string | null]> => {
          const was = before.nodes.get(t.node);
          return was ? [[was.parent, segmentOf(was), null]] : [];
        }),
        ...touched.flatMap((t): Array<[string, string, string | null]> => {
          const now = after.nodes.get(t.node);
          return now && !now.trashed ? [[now.parent, segmentOf(now), t.node]] : [];
        }),
      ],
    },
  };
}

function touchedNodes(cx: Context, before: TreeProjection, after: TreeProjection): TouchedNode[] {
  const named = new Set(cx.made.map((made) => made.node));
  const touched: TouchedNode[] = [];
  for (const [id, node] of after.nodes) {
    const was = before.nodes.get(id);
    if (
      was &&
      !named.has(id) &&
      was.parent === node.parent &&
      segmentOf(was) === segmentOf(node) &&
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
