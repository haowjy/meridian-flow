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
  descendantsOf,
  isSourceRoot,
  LIVE,
  listRecords,
  sourceRoot,
  type TreeNode,
  type TreeProjection,
  type TreeRecord,
} from "@meridian/project-tree";
import type { TreeScope } from "../ports/context-adapter.js";
import {
  changeDelta,
  type NamesShown,
  pathNames,
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

export type Refused = {
  ok: false;
  status: "gone" | "path_changed" | "invalid_write" | "document_not_found";
  /** The typed cause beside the status, in the shape the text side uses for a change not made. */
  refusal?: "target_gone" | "would_loop" | "path_changed" | "already_at_destination";
  path: string;
  message: string;
  delta: ShownDelta;
};

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
  alreadyDeleted?: true;
  deletedInLive?: true;
  /** Changes by others to the nodes the call named, by author. */
  concurrent: Array<{ author: string; lines: string[] }>;
  /** Documents and files a delete took, for the Works whose drafts outlive it. */
  taken: string[];
  /** Documents now at a live address. */
  arrived: string[];
  delta: ShownDelta;
};

export type TreeResult = Refused | Done;

function lastWhere<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let at = items.length - 1; at >= 0; at -= 1) if (test(items[at] as T)) return items[at];
  return undefined;
}

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
  const entry = lastWhere(
    projection.trash,
    (candidate) => candidate.node === node.id || candidate.cascade.includes(node.id),
  );
  return actorOfRecord(cx, entry?.from ?? entry?.id);
}

const refuse = (
  status: Refused["status"],
  path: string,
  message: string,
  extra: Partial<Pick<Refused, "refusal" | "delta">> = {},
): Refused => ({
  ok: false,
  status,
  path,
  message,
  delta: extra.delta ?? { whole: [], names: [] },
  ...(extra.refusal ? { refusal: extra.refusal } : {}),
});

/** A refusal for a resolution that is not a node. */
function unresolved(
  cx: Context,
  projection: TreeProjection,
  verb: string,
  written: string,
  resolution: Exclude<Resolution, { kind: "node" }>,
): Refused {
  const path = uriOfPath(cx, written);
  switch (resolution.kind) {
    case "path_changed": {
      const where = nodeUri(cx, projection, resolution.was);
      const kind = resolution.now.kind === "folder" ? "folder" : "document";
      return refuse(
        "path_changed",
        path,
        `Nothing done: ${path} now names a different ${kind}. The one you were shown is now ${where}. Use the path of the one you mean.`,
        {
          refusal: "path_changed",
          // Every name the message states: the old name now means the new node, the old node is where it is.
          delta: {
            whole: [],
            names: [
              [resolution.folder, resolution.name, resolution.now.id],
              [
                resolution.was.parent,
                resolution.was.displayName,
                resolution.was.trashed ? null : resolution.was.id,
              ],
            ],
          },
        },
      );
    }
    case "gone":
      return refuse(
        "gone",
        path,
        `Not ${verb}: ${labelOf(deleterOf(cx, projection, resolution.node) ?? "")} deleted it after you last listed it. \`restore\` brings it back.`.replace(
          "unattributed deleted",
          "it was deleted",
        ),
        { refusal: "target_gone" },
      );
    case "not_a_folder":
      return refuse(
        "document_not_found",
        path,
        `${uriOf(cx.area, pathNames(projection, resolution.node.id), false)} is a document, not a folder.`,
      );
    case "missing":
      return refuse(
        "document_not_found",
        path,
        "File not found. Read the project to find the right path.",
      );
  }
}

const isFolderPath = (path: string) => path.endsWith("/");

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
  const setters = projection.setters.get(node.id);
  const nowName = node.displayName;
  const sameName =
    nowName === writtenLeaf ||
    nowName === (written.folder ? writtenLeaf : canonicalLeaf(writtenLeaf));
  if (!sameName)
    noteConcurrent(
      cx,
      actorOfRecord(cx, setters?.label?.id),
      `renamed: ${writtenUri} → ${nowName}`,
    );
  const writtenParent = written.segments.slice(0, -1);
  const nowParent = pathNames(projection, node.id).slice(0, -1);
  if (writtenParent.join("/") !== nowParent.join("/"))
    noteConcurrent(
      cx,
      actorOfRecord(cx, setters?.place?.id),
      `moved: ${writtenUri} → ${uriOf(areaOfNode(cx, node), nowParent, true)}`,
    );
}

function remember(cx: Context, record: string, node: string) {
  cx.made.push({ record, node });
}

/** The folders of `segments` under `from`, made where they do not exist yet. */
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

/** The parent folder a path's leaf goes under: resolved through the map, with what is missing made. */
function destinationParent(
  cx: Context,
  to: Located,
  folders: readonly string[],
  filled: Array<{ folder: string; name: string; node: string }>,
):
  | {
      ok: true;
      parent: string;
      trashed: TreeNode[];
      through: Array<{ folder: string; name: string; node: string }>;
    }
  | { ok: false; refused: Refused } {
  const projection = cx.scope.writer.view(cx.scope.view);
  if (folders.length === 0) return { ok: true, parent: to.root, trashed: [], through: [] };
  const found = resolveShown(
    projection,
    cx.shown,
    to.root,
    { segments: folders, folder: true },
    { through: true },
  );
  if (found.kind === "node") {
    if (found.node.kind !== "folder")
      return {
        ok: false,
        refused: refuse(
          "invalid_write",
          uriOf(to.area, folders, true),
          `${nodeUri(cx, projection, found.node)} is a document, not a folder.`,
        ),
      };
    return { ok: true, parent: found.node.id, trashed: found.trashed, through: found.along };
  }
  if (found.kind === "missing") {
    const start = found.along.at(-1)?.node ?? to.root;
    const parent = ensureFolders(cx, start, folders.slice(found.at), filled);
    return { ok: true, parent, trashed: found.trashed, through: found.along };
  }
  return {
    ok: false,
    refused: unresolved(cx, projection, "moved", uriOf(to.area, folders, true), found),
  };
}

/** The place among the new folder's shown children a position names, and what to say if its anchor left. */
function indexFor(
  cx: Context,
  parent: string,
  moving: string | undefined,
  position: Placement | undefined,
): { index: number; atEnd?: string } {
  const projection = cx.scope.writer.view(cx.scope.view);
  const siblings = childrenOf(projection, parent).filter((node) => node.id !== moving);
  if (!position || position.kind === "end") return { index: siblings.length };
  if (position.kind === "start") return { index: 0 };
  const written = pathFrom(cx, position.sibling);
  const sibling = resolveShown(projection, cx.shown, written.root, written);
  const at =
    sibling.kind === "node" ? siblings.findIndex((node) => node.id === sibling.node.id) : -1;
  if (at < 0)
    return {
      index: siblings.length,
      atEnd: `${uriOfPath(cx, position.sibling)} is no longer in this folder`,
    };
  return { index: position.kind === "before" ? at : at + 1 };
}

/** Whether `parent` is `node` or inside it: a move there would put a folder inside itself. */
function loops(projection: TreeProjection, node: TreeNode, parent: string): boolean {
  return (
    node.kind === "folder" &&
    (parent === node.id || descendantsOf(projection, node.id).includes(parent))
  );
}

/** The sentence's cause when the model's own path does not put the folder inside itself. */
function loopCause(
  cx: Context,
  projection: TreeProjection,
  node: TreeNode,
  through: Array<{ folder: string; name: string; node: string }>,
  written: Located,
): string {
  // The folder directly under `node` on the way down to the destination is what someone moved in.
  const chain: string[] = [];
  const target = through.at(-1)?.node;
  for (let at = target; at && at !== node.id; at = projection.nodes.get(at)?.parent)
    chain.unshift(at);
  const inside = chain[0] ? projection.nodes.get(chain[0]) : undefined;
  const along = through.findIndex((step) => step.node === inside?.id);
  // The model wrote the path through `node` itself: nobody else is the cause.
  if (!inside || through.some((step) => step.node === node.id) || along < 0) return "";
  const who = actorOfRecord(cx, projection.setters.get(inside.id)?.place?.id);
  if (who === undefined || who === cx.scope.actor) return "";
  const named = uriOf(written.area, written.segments.slice(0, along + 1), true);
  return `: ${labelOf(who)} moved ${named} into it after you last listed it.`;
}

function moveOne(
  cx: Context,
  from: string,
  to: Located,
  toUri: string,
  position: Placement | undefined,
  filled: Array<{ folder: string; name: string; node: string }>,
  emptied: Array<{ folder: string; name: string }>,
  viaMany: boolean,
):
  | { done: Done; fail?: undefined }
  | { fail: Refused; done?: undefined }
  | { skip: string; fail?: undefined; done?: undefined } {
  const { scope } = cx;
  const projection = scope.writer.view(scope.view);
  const source = pathFrom(cx, from);
  const found = resolveShown(projection, cx.shown, source.root, source);
  if (found.kind !== "node") {
    const refused = unresolved(cx, projection, "moved", from, found);
    return viaMany
      ? {
          skip: `${from} (${found.kind === "gone" ? `deleted by ${labelOf(deleterOf(cx, projection, found.node) ?? "")}` : refused.status === "path_changed" ? "its name now means another document" : "not found"})`,
        }
      : { fail: refused };
  }
  const node = found.node;
  noteChanges(cx, projection, node, source, uriOfPath(cx, from));
  const parent = destinationParent(cx, to, to.segments.slice(0, -1), filled);
  if (!parent.ok)
    return viaMany ? { skip: `${from} (${parent.refused.status})` } : { fail: parent.refused };
  const after = scope.writer.view(scope.view);
  if (loops(after, node, parent.parent)) {
    const cause = loopCause(cx, after, node, parent.through, to);
    const into = nodeUri(cx, projection, node);
    return viaMany
      ? { skip: `${from} (would put it inside itself)` }
      : {
          fail: refuse(
            "invalid_write",
            toUri,
            `Not moved: it would put ${into} inside itself${cause || "."}`,
            { refusal: "would_loop" },
          ),
        };
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
      });
      if (!parsed.ok)
        return viaMany
          ? { skip: `${from} (${parsed.message})` }
          : { fail: refuse("invalid_write", toUri, parsed.message) };
      name = parsed.name;
      filetype = parsed.filename.filetype;
    }
  }
  const sameParent = node.parent === parent.parent;
  if (sameParent && name === undefined && !position)
    return viaMany
      ? { skip: `${from} (already there)` }
      : {
          fail: refuse("invalid_write", toUri, `The document is already at ${toUri}.`, {
            refusal: "already_at_destination",
          }),
        };

  const { index, atEnd } = indexFor(cx, parent.parent, node.id, position);
  const oldParent = node.parent;
  const oldName = node.displayName;
  if (!sameParent || position) {
    const record = scope.writer.move(scope.view, scope.actor, node.id, parent.parent, index);
    remember(cx, record.id, node.id);
  }
  if (name !== undefined) {
    const record = scope.writer.rename(
      scope.view,
      scope.actor,
      node.id,
      name,
      filetype && filetype !== node.filetype ? filetype : undefined,
    );
    remember(cx, record.id, node.id);
  }
  const final = scope.writer.view(scope.view);
  const landedNode = final.nodes.get(node.id) as TreeNode;
  emptied.push({ folder: oldParent, name: oldName });
  filled.push({ folder: landedNode.parent, name: landedNode.displayName, node: node.id });
  const landedAt = nodeUri(cx, final, landedNode);
  return {
    done: {
      ok: true,
      subject: node.id,
      made: [],
      shownAt: from,
      landedAt,
      ...(landedAt !== toUri ? { landed: landedAt } : {}),
      ...(atEnd ? { placedAtEnd: atEnd } : {}),
      ...(landedNode.keptByPending ? { deletedInLive: true as const } : {}),
      notMoved: [],
      concurrent: [],
      taken: [],
      arrived: node.kind === "folder" ? [] : [node.id],
      delta: { whole: [], names: [] },
    },
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
    }
  | { kind: "unresolved" }
  | { kind: "refused"; refused: Refused };

/**
 * Resolves a path through the names shown, for the tools that read or write inside a document:
 * the node it meant and where it is now, a refusal when the name now means another node or the
 * node was deleted, or nothing when neither the map nor the tree holds the path.
 */
export function reachPath(
  scope: Pick<TreeScope, "writer" | "view" | "root">,
  area: string,
  shown: NamesShown,
  path: string,
  verb: string,
  options: { allowGone?: boolean } = {},
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
  const resolved = resolveShown(projection, shown, scope.root, pathFrom(cx, path));
  // Undo names what was deleted by its old path: the node in Trash is the one it means.
  const found: Resolution =
    options.allowGone && resolved.kind === "gone"
      ? { kind: "node", node: resolved.node, along: [], parent: resolved.node.parent, trashed: [] }
      : resolved;
  if (found.kind === "missing" || found.kind === "not_a_folder") return { kind: "unresolved" };
  if (found.kind !== "node")
    return {
      kind: "refused",
      refused: unresolved(
        cx,
        projection,
        verb,
        path.includes("://") ? path : `${area}${path}`,
        found,
      ),
    };
  return {
    kind: "node",
    node: {
      id: found.node.id,
      kind: found.node.kind,
      entries: childrenOf(projection, found.node.id).length,
    },
    uri: nodeUri(cx, projection, found.node),
    delta: { whole: [], names: found.along.map((e) => [e.folder, e.name, e.node]) },
  };
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
  const finish = (done: Done): Done => ({
    ...done,
    made: cx.made,
    concurrent: [...cx.concurrent].map(([author, lines]) => ({ author, lines })),
  });
  const filled: Array<{ folder: string; name: string; node: string }> = [];
  const emptied: Array<{ folder: string; name: string }> = [];
  const projection = scope.writer.view(scope.view);

  switch (command.command) {
    case "create": {
      const path = pathFrom(cx, command.path);
      const found = resolveShown(projection, shown, path.root, path);
      if (found.kind === "node")
        return refuse(
          "invalid_write",
          command.path,
          `${nodeUri(cx, projection, found.node)} already exists.`,
        );
      const parent = destinationParent(cx, path, path.segments.slice(0, -1), filled);
      if (!parent.ok) return parent.refused;
      const leaf = path.segments.at(-1);
      if (leaf === undefined)
        return refuse("invalid_write", command.path, "A folder needs a name.");
      const last = ensureFolders(cx, parent.parent, [leaf], filled);
      const landedNode = scope.writer.view(scope.view).nodes.get(last) as TreeNode;
      const landedAt = nodeUri(cx, scope.writer.view(scope.view), landedNode);
      return finish({
        ok: true,
        subject: last,
        made: [],
        shownAt: command.path,
        landedAt,
        ...(landedAt !== command.path ? { landed: landedAt } : {}),
        notMoved: [],
        concurrent: [],
        taken: [],
        arrived: [],
        delta: changeDelta([], filled),
      });
    }

    case "move": {
      const to = pathFrom(cx, command.path);
      const toUri = uriOfPath(cx, command.path);
      if (!command.many) {
        const from = command.from[0] as string;
        const moved = moveOne(cx, from, to, toUri, command.position, filled, emptied, false);
        if ("skip" in moved) return refuse("invalid_write", toUri, `Nothing moved: ${moved.skip}`);
        if (moved.fail) return moved.fail;
        return finish({ ...moved.done, delta: changeDelta(emptied, filled) });
      }
      // Several into one folder: each on its own, what could be moved is moved.
      const folder = destinationParent(cx, to, to.segments, filled);
      if (!folder.ok) return folder.refused;
      const notMoved: string[] = [];
      const arrived: string[] = [];
      let made = 0;
      let subject: string = folder.parent;
      for (const from of command.from) {
        const leaf = pathFrom(cx, from).segments.at(-1) ?? "";
        const item = {
          ...to,
          segments: [...to.segments, leaf],
          folder: isFolderPath(from),
        };
        const result = moveOne(
          cx,
          from,
          item,
          `${toUri.replace(/\/?$/, "/")}${leaf}`,
          undefined,
          filled,
          emptied,
          true,
        );
        if ("skip" in result) notMoved.push(result.skip);
        else if (result.done) {
          made += 1;
          arrived.push(...result.done.arrived);
          subject = folder.parent;
        } else notMoved.push(`${from} (${result.fail?.status})`);
      }
      if (made === 0)
        return refuse("invalid_write", toUri, `Nothing moved: ${notMoved.join("; ")}`);
      const landedAt = uriOf(to.area, to.segments, true);
      return finish({
        ok: true,
        subject,
        made: [],
        shownAt: command.path,
        landedAt,
        moved: { made, of: command.from.length },
        notMoved,
        concurrent: [],
        taken: [],
        arrived,
        delta: changeDelta(emptied, filled),
      });
    }

    case "delete": {
      const path = pathFrom(cx, command.path);
      const found = resolveShown(projection, shown, path.root, path);
      if (found.kind === "gone") {
        return finish({
          ok: true,
          subject: found.node.id,
          made: [],
          shownAt: command.path,
          landedAt: command.path,
          alreadyDeleted: true,
          notMoved: [],
          concurrent: [],
          taken: [],
          arrived: [],
          delta: { whole: [], names: [] },
        });
      }
      if (found.kind !== "node") return unresolved(cx, projection, "deleted", command.path, found);
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
      const keptNote =
        kept.length > 0
          ? `${nodeUri(cx, after, after.nodes.get(node.id) as TreeNode)} with ${kept
              .map((id) => nodeUri(cx, after, after.nodes.get(id) as TreeNode))
              .join(", ")}, added by ${labelOf(
              (after.nodes.get(kept[0] as string) as TreeNode).createdBy,
            )} after you last listed it`
          : undefined;
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
        delta: changeDelta([{ folder: node.parent, name: node.displayName }], []),
      });
    }

    case "restore": {
      const path = pathFrom(cx, command.path);
      const fromMap = resolveShown(projection, shown, path.root, path);
      let node: TreeNode | undefined;
      if (fromMap.kind === "gone") node = fromMap.node;
      else if (fromMap.kind === "node" && fromMap.node.trashed) node = fromMap.node;
      else if (fromMap.kind === "node")
        return refuse("invalid_write", command.path, `${command.path} is not in Trash.`);
      else {
        // The path the node had when it was deleted: Trash keeps each node's parent chain.
        const wanted = path.segments.join("/");
        const entry = lastWhere(projection.trash, (candidate) => {
          const at = [candidate.node, ...candidate.cascade].find(
            (id) => pathNames(projection, id).join("/") === wanted,
          );
          return at !== undefined;
        });
        const id =
          entry &&
          [entry.node, ...entry.cascade].find((x) => pathNames(projection, x).join("/") === wanted);
        node = id ? projection.nodes.get(id) : undefined;
      }
      if (!node)
        return refuse("document_not_found", command.path, "Nothing in Trash had that path.");
      const target = node;
      const wasTrashedAbove: TreeNode[] = [];
      for (
        let at = projection.nodes.get(target.parent);
        at;
        at = isSourceRoot(at.parent) ? undefined : projection.nodes.get(at.parent)
      )
        if (at.trashed) wasTrashedAbove.push(at);
      const entry = lastWhere(projection.trash, (candidate) => candidate.node === target.id);
      const record = entry
        ? scope.writer.restoreEntry(scope.view, scope.actor, entry.from ?? entry.id)
        : scope.writer.restore(scope.view, scope.actor, target.id);
      if (record === "unknown")
        return refuse("invalid_write", command.path, "That delete is not in this view.");
      remember(cx, record.id, target.id);
      const after = scope.writer.view(scope.view);
      const landedNode = after.nodes.get(target.id) as TreeNode;
      const landedAt = nodeUri(cx, after, landedNode);
      const keptFolders = wasTrashedAbove.filter(
        (folder) => after.nodes.get(folder.id)?.keptByChild,
      );
      return finish({
        ok: true,
        subject: target.id,
        made: [],
        shownAt: command.path,
        landedAt,
        ...(landedAt !== command.path ? { landed: landedAt } : {}),
        ...(keptFolders.length > 0
          ? { kept: keptFolders.map((folder) => nodeUri(cx, after, folder)).join(", ") }
          : {}),
        notMoved: [],
        concurrent: [],
        taken: [],
        arrived: landedNode.kind === "folder" ? [] : [target.id],
        delta: changeDelta(
          [],
          [{ folder: landedNode.parent, name: landedNode.displayName, node: target.id }],
        ),
      });
    }
  }
}

export { LIVE };
