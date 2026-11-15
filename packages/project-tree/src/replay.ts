import { classifyFiletype } from "@meridian/contracts/protocol";
import { freeName, shownName } from "./names.js";
import {
  type Actor,
  type BlobRef,
  isListRoot,
  isSourceRoot,
  type NodeKind,
  type PurgeRecord,
  sourceIdOf,
  sourceRoot,
  type TreeRecord,
} from "./record.js";
import { readStored } from "./validate.js";

export type TreeNode = {
  id: string;
  kind: NodeKind;
  name: string;
  /** The name shown: `name`, or a numbered copy when a sibling already shows that name (rule 4). */
  displayName: string;
  /** A folder's id, or a source root. */
  parent: string;
  /** The source this node is in now, from the top of its parent chain. */
  source: string;
  rank: string;
  /** A document's type: the last rename's that changed it, else its create's. */
  filetype?: string;
  /** The name was given, not chosen; false once a person has renamed the node. */
  provisional: boolean;
  aliases?: string[];
  hasProperties: boolean;
  /** In Trash: deleted, and nothing not deleted below it keeps it standing. */
  trashed: boolean;
  /** Deleted, but shown because something not deleted is inside (rule 3). */
  keptByChild: boolean;
  /**
   * Deleted in live, but shown in this Work's view because the Work has a pending change to it
   * (rule 7). Review marks it "deleted in live"; Apply leaves the change pending.
   */
  keptByPending: boolean;
  /** Trash emptied: gone for good, and in no Trash entry. */
  purged: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  /** The actor of the record that last changed where it is or what it is called. */
  lastChangedBy: Actor;
  /** Order of arrival under its name, which decides who shows a number (rule 4). */
  arrival: number;
};

export type SkipReason =
  | "cycle"
  | "missing-node"
  | "missing-parent"
  | "parent-not-folder"
  | "duplicate"
  | "purged"
  /** Rule 11: a document create or rename to a type that is not a tracked document. */
  | "type-not-editable"
  /** Rule 12: a rename to a type of another Yjs schema. */
  | "type-across-schemas"
  /** The value is not a record the server writes (decoded from a list that was changed outside the package). */
  | "unreadable";

/** One delete still in force: a Trash entry, with what it still takes. */
export type TrashEntry = {
  /** The delete record's id (a record that carries another names it in `from`). */
  id: string;
  from?: string;
  node: string;
  cascade: string[];
};

/**
 * The record that last set a fact of a node, with the fact's values just before it. Undo is
 * allowed while a record is still the one that last set what it set, and the opposite record
 * carries these values back; an opposite record takes its target off the top, so the record
 * before it is the last again.
 */
export type Setter<Before> = {
  id: string;
  /** The root original this record carries, which an Undo's `undoes` names. */
  carries?: string;
  before: Before;
  /** The node's arrival before it, which the opposite record puts back. */
  arrivedBefore: number;
};
export type LabelBefore = { name: string; filetype?: string };
export type PlaceBefore = { parent: string; rank: string };
export type NodeSetters = { label?: Setter<LabelBefore>; place?: Setter<PlaceBefore> };

export type TreeProjection = {
  nodes: Map<string, TreeNode>;
  /** Per node, who last set its name and type (a rename) and its place (a move). */
  setters: Map<string, NodeSetters>;
  /** Children of a folder or source root, in display order: by rank, then id. Trashed ones included. */
  children: Map<string, TreeNode[]>;
  /** Records the replay skipped, with why: what a review shows as "couldn't apply". */
  skipped: Array<{ record: string; reason: SkipReason }>;
  /** Creates whose folder was never created in this view: put at the top of their source (rule 6). */
  rescued: string[];
  /** Trash: the deletes still in force. Per view, like the tree. */
  trash: TrashEntry[];
  /**
   * The root ids of the deletes Undo may still take back: each Trash entry's own, and a delete
   * that took a restore back (its entries and cascade members are in Trash again) while one of
   * those stands.
   */
  standingDeletes: ReadonlySet<string>;
  /** Documents in no view whose content was purged: a Discarded create, emptied from Trash. */
  gone: ReadonlySet<string>;
  /** Records the server dropped at admission (from the settle log; `replayView` fills it, `replay` has no log). */
  dropped: DroppedRecord[];
};

/** A record the server stamped `dropped` (it changed a closed Work), and the reason it gave. */
export type DroppedRecord = { record: Exclude<TreeRecord, PurgeRecord>; reason: string };

type Working = {
  id: string;
  kind: NodeKind;
  name: string;
  parent: string;
  rank: string;
  /** The source it was created in; the shown source is derived from the parent chain. */
  source: string;
  filetype?: string;
  provisional: boolean;
  aliases?: string[];
  hasProperties: boolean;
  blob?: BlobRef;
  createdBy: Actor;
  lastChangedBy: Actor;
  createdAt: number;
  /** Position of the record that last brought it to its parent under its name: who gets a number. */
  arrivedAt: number;
  purged: boolean;
  /** The create it was made by, or the original a copy of that create carries. */
  root: string;
  label: Array<Setter<LabelBefore>>;
  place: Array<Setter<PlaceBefore>>;
};

/** The deletes a restore lifted, and the members it took out of the deletes of folders above it; `by` is the kind of record that lifted them. */
type Lifted = {
  by: TreeRecord["type"];
  entries: DeleteInForce[];
  members: Array<[DeleteInForce, string]>;
};

type DeleteInForce = {
  id: string;
  from?: string;
  /**
   * By the root id of each delete that took a restore back: the nodes of this entry it put in
   * force again (the entry's own, or members of its cascade), until a restore lifts them again.
   */
  putBackBy: Map<string, Set<string>>;
  node: string;
  cascade: Set<string>;
  /** The viewed Work's own delete, pending or already applied. */
  own: boolean;
};

/**
 * Turns records, in replay order, into a tree: the eight rules of the design, section 2. Each
 * value is read through `readStored` and the replay uses the copy that builds; one that is not a
 * record is skipped as `unreadable`.
 * `of.draft` is the Work whose view this is (null for live); `of.pendingText` the documents it
 * holds pending text of, which the list cannot see.
 */
export function replay(
  values: readonly unknown[],
  of: { draft?: string | null; pendingText?: ReadonlySet<string> } = {},
): TreeProjection {
  const nodes = new Map<string, Working>();
  const skipped: TreeProjection["skipped"] = [];
  const rescued: string[] = [];
  const gone = new Set<string>();
  const ownDelete = (record: TreeRecord) =>
    record.draft !== null || (of.draft != null && record.fromDraft === of.draft);
  // Rule 10: a purge is final wherever it sits. A Yjs-merged record placed before it in the list
  // (an offline restore or move admitted later) never lifts the delete it empties.
  const purgedDeletes = new Set<string>();
  // Each purged node, by the position of the purge that took it.
  const purgedAt = new Map<string, number>();
  for (const value of values) {
    const read = readStored(value);
    if (read.ok && read.record.type === "purge") purgedDeletes.add(read.record.delete);
  }
  const isFinal = (entry: DeleteInForce) =>
    purgedDeletes.has(entry.id) || (entry.from !== undefined && purgedDeletes.has(entry.from));
  let deletes: DeleteInForce[] = [];
  // What a restore lifted, and what a delete that took a restore back put in force again, by
  // the id an Undo of it names: taking either back undoes exactly that.
  const lifted = new Map<string, Lifted>();
  const pendingOn = new Map<string, Set<string>>();
  // A drafted change and the drafted record that takes it back leave nothing pending.
  const pend = (record: TreeRecord) => {
    if (record.draft === null) return;
    const on = pendingOn.get(record.node) ?? new Set<string>();
    if (record.undoes !== undefined && on.has(record.undoes)) on.delete(record.undoes);
    else on.add(record.carries ?? record.id);
    pendingOn.set(record.node, on);
  };

  const isAncestor = (maybeAncestor: string, of: string): boolean => {
    let at: string | undefined = of;
    for (let guard = 0; at !== undefined && guard <= nodes.size; guard += 1) {
      if (at === maybeAncestor) return true;
      at = nodes.get(at)?.parent;
    }
    return false;
  };

  // A node still in this list that something may be placed under or done to: purged nodes are in
  // no view, for placement as for display.
  const placeable = (id: string) => placeIn(nodes, id);

  // Lifts the deletes a restore (or, by rule 9, a move or rename of a node in Trash) takes back.
  // A touch by a drafted record lifts only the Work's own deletes: a live delete stays in force
  // in the Work's view (rule 7), and is lifted when the Apply lands the record live.
  const lift = (
    record: TreeRecord,
    node: Working,
    how: { index: number } | { ownOnly: boolean },
  ) => {
    const touch = "ownOnly" in how;
    const may = (entry: DeleteInForce) => !isFinal(entry) && (!touch || !how.ownOnly || entry.own);
    // Rule 8. A restore that takes one delete back lifts that delete alone, so one
    // author's Undo never reverses another's delete of the same node. A plain restore lifts
    // every delete of the node. Out of a deleted folder either brings back only the node
    // and what is inside it: they leave that folder's delete, and the folder stands holding
    // them (rule 3) with the rest in Trash. A restore that takes back the Undo of a restore
    // lifts again what that Undo put back.
    const again = record.undoes === undefined ? undefined : lifted.get(record.undoes);
    const took: Lifted = {
      by: record.type,
      entries: deletes.filter(
        (entry) => may(entry) && (again ? again.entries.includes(entry) : lifts(record, entry)),
      ),
      members: [],
    };
    deletes = deletes.filter((entry) => !took.entries.includes(entry));
    for (const entry of took.entries) entry.putBackBy.clear();
    if (!touch) node.arrivedAt = how.index;
    const takeOut = (entry: DeleteInForce, member: string) => {
      entry.cascade.delete(member);
      for (const nodes of entry.putBackBy.values()) nodes.delete(member);
      took.members.push([entry, member]);
    };
    if (again) for (const [entry, member] of again.members) takeOut(entry, member);
    else if (record.undoes === undefined)
      for (const entry of deletes) {
        if (!may(entry) || !isAncestor(entry.node, record.node)) continue;
        for (const member of [...entry.cascade])
          if (member === record.node || isAncestor(record.node, member)) takeOut(entry, member);
      }
    // A create's Undo is a plain delete of the node: nothing to put back.
    if (record.type !== "create") lifted.set(record.carries ?? record.id, took);
  };

  // An Undo of a restore (or of a move or rename that lifted deletes, rule 9) takes it off: the
  // deletes it lifted are in force again, each with what it took and its own Trash entry.
  const putBack = (record: TreeRecord, back: Lifted) => {
    const root = record.carries ?? record.id;
    const put = (entry: DeleteInForce, node: string) =>
      entry.putBackBy.set(root, (entry.putBackBy.get(root) ?? new Set()).add(node));
    for (const entry of back.entries) {
      put(entry, entry.node);
      if (!deletes.includes(entry)) deletes.push(entry);
    }
    for (const [entry, member] of back.members) {
      entry.cascade.add(member);
      put(entry, member);
    }
    lifted.set(root, back);
  };

  // A record sets a fact: it goes on the node's stack of setters, and an Undo's opposite record
  // takes its target off instead, putting back the arrival it moved (so an undone move or
  // rename shows the names it showed before, not a numbered copy).
  const setFact = <Before>(
    stack: Array<Setter<Before>>,
    node: Working,
    record: TreeRecord,
    index: number,
    before: Before,
    changed: boolean,
    arrivedBefore = node.arrivedAt,
  ) => {
    const top = stack[stack.length - 1];
    if (
      record.undoes !== undefined &&
      top &&
      (top.id === record.undoes || top.carries === record.undoes)
    ) {
      stack.pop();
      node.arrivedAt = top.arrivedBefore;
      return;
    }
    stack.push({
      id: record.id,
      ...(record.carries ? { carries: record.carries } : {}),
      before,
      arrivedBefore,
    });
    if (changed) node.arrivedAt = index;
  };

  for (const [index, value] of values.entries()) {
    const read = readStored(value);
    if (!read.ok) {
      const id = (value as { id?: unknown } | null)?.id;
      skipped.push({ record: typeof id === "string" ? id : "", reason: "unreadable" });
      continue;
    }
    const record = read.record;
    const skip = (reason: SkipReason) => skipped.push({ record: record.id, reason });
    if (record.type === "create") {
      const existing = nodes.get(record.node);
      if (existing) {
        // The same create applied again after an Undo of its Apply (the first copy's node is in
        // Trash): it brings the node back, as a move would (rule 9). Any other is a repeat.
        if (existing.root !== (record.carries ?? record.id)) {
          skip("duplicate");
          continue;
        }
        lift(record, existing, { ownOnly: record.draft !== null });
        pend(record);
        continue;
      }
      if (record.kind === "document" && !isTracked(record.filetype)) {
        skip("type-not-editable");
        continue;
      }
      let parentId = record.parent;
      if (!isSourceRoot(record.parent) && placeable(record.parent)?.kind !== "folder") {
        // Rule 6: the folder it was made in was never created in this view (its create was
        // discarded concurrently), so the node shows at the top of its source.
        parentId = sourceRoot(record.source);
        rescued.push(record.id);
      }
      nodes.set(record.node, {
        id: record.node,
        kind: record.kind,
        name: shownName(record.kind, record.name),
        parent: parentId,
        rank: record.rank,
        source: record.source,
        ...(record.filetype ? { filetype: record.filetype } : {}),
        provisional: record.provisional === true,
        ...(record.aliases ? { aliases: record.aliases } : {}),
        hasProperties: record.hasProperties === true,
        ...(record.blob ? { blob: record.blob } : {}),
        createdBy: record.actor,
        lastChangedBy: record.actor,
        createdAt: index,
        arrivedAt: index,
        purged: false,
        root: record.carries ?? record.id,
        label: [],
        place: [],
      });
      continue;
    }
    // A node is acted on only while it stands in this view (`placeIn`): the same test Undo and
    // restoring a Discard make before they append a record.
    const node = placeable(record.node);
    // A Discarded create is in no view: its purge is the one record that names a node not in
    // this one, and it says the document's content is gone.
    if (record.type === "purge" && !nodes.has(record.node)) {
      gone.add(record.node);
      continue;
    }
    if (!node) {
      skip(nodes.has(record.node) ? "purged" : "missing-node");
      continue;
    }
    switch (record.type) {
      case "move": {
        // Out to another list: the node is in no view of this one, and its Trash entries go.
        if (isListRoot(record.parent)) {
          nodes.delete(record.node);
          break;
        }
        if (!isSourceRoot(record.parent)) {
          const parent = placeable(record.parent);
          if (!parent) {
            skip("missing-parent");
            continue;
          }
          if (parent.kind !== "folder") {
            skip("parent-not-folder");
            continue;
          }
        }
        // Rule 1: a move that would put a folder inside itself is skipped.
        if (isAncestor(record.node, record.parent)) {
          skip("cycle");
          continue;
        }
        // Rule 9: acting on a node in Trash brings it back (an Undo's opposite record never does).
        const back = record.undoes === undefined ? undefined : lifted.get(record.undoes);
        if (back) putBack(record, back);
        else if (record.undoes === undefined)
          lift(record, node, { ownOnly: record.draft !== null });
        pend(record);
        // One arrival sets both facts, so both answer to the arrival before it.
        const arrivedBefore = node.arrivedAt;
        setFact(
          node.place,
          node,
          record,
          index,
          { parent: node.parent, rank: node.rank },
          node.parent !== record.parent,
        );
        if (record.name !== undefined) {
          setFact(
            node.label,
            node,
            record,
            index,
            { name: node.name, ...(node.filetype ? { filetype: node.filetype } : {}) },
            node.name !== shownName(node.kind, record.name),
            arrivedBefore,
          );
          node.name = shownName(node.kind, record.name);
          if (record.actor.startsWith("user:")) node.provisional = false;
        }
        node.parent = record.parent;
        node.rank = record.rank;
        node.lastChangedBy = record.actor;
        break;
      }
      case "rename": {
        if (record.filetype !== undefined) {
          if (!isTracked(record.filetype)) {
            skip("type-not-editable");
            continue;
          }
          if (!node.filetype || schemaOf(node.filetype) !== schemaOf(record.filetype)) {
            skip("type-across-schemas");
            continue;
          }
        }
        // A rename that takes back only the name a move set leaves the deletes that move lifted lifted.
        const back = record.undoes === undefined ? undefined : lifted.get(record.undoes);
        if (back?.by === "rename") putBack(record, back);
        else if (record.undoes === undefined)
          lift(record, node, { ownOnly: record.draft !== null });
        pend(record);
        setFact(
          node.label,
          node,
          record,
          index,
          { name: node.name, ...(node.filetype ? { filetype: node.filetype } : {}) },
          node.name !== shownName(node.kind, record.name),
        );
        node.name = shownName(node.kind, record.name);
        if (record.filetype) node.filetype = record.filetype;
        // A rename to the same name counts: it is how a writer keeps "Untitled" on purpose.
        if (record.actor.startsWith("user:")) node.provisional = false;
        node.lastChangedBy = record.actor;
        break;
      }
      case "delete": {
        const back = record.undoes === undefined ? undefined : lifted.get(record.undoes);
        if (back) {
          putBack(record, back);
          break;
        }
        // Two deletes of one node both count: each takes what its author saw.
        deletes.push({
          id: record.id,
          ...(record.carries ? { from: record.carries } : {}),
          putBackBy: new Map(),
          node: record.node,
          cascade: new Set(record.cascade),
          own: ownDelete(record),
        });
        break;
      }
      case "restore":
        lift(record, node, { index });
        break;
      case "purge": {
        // Rule 10: final, and exactly what the server found the delete covering when it purged
        // (and whose content it released). A node someone put inside since, by a record placed
        // before the purge but admitted after it, was not purged: it goes to its source's top.
        const entry = deletes.find((d) => d.id === record.delete || d.from === record.delete);
        if (!entry || entry.node !== record.node) {
          skip("missing-node");
          break;
        }
        for (const id of record.nodes) {
          const gone = nodes.get(id);
          if (gone && !gone.purged) {
            gone.purged = true;
            purgedAt.set(id, index);
          }
        }
        deletes = deletes.filter((d) => d !== entry);
        break;
      }
    }
  }

  if (purgedAt.size > 0) rescueFromPurged(nodes, purgedAt);
  return {
    ...derive(nodes, deletes, pendingOn, of.pendingText ?? new Set(), skipped, rescued, gone),
    dropped: [],
  };
}

/**
 * Every node standing directly under a purged one goes to the top of the source its place was in,
 * arriving there at that purge. Once purged a node takes nothing (`placeIn`), so what is under one
 * at the end was under it at its purge.
 */
function rescueFromPurged(nodes: Map<string, Working>, purgedAt: ReadonlyMap<string, number>) {
  const sourceAbove = (id: string) => {
    let parent = id;
    for (let guard = 0; !isSourceRoot(parent) && guard <= nodes.size; guard += 1)
      parent = nodes.get(parent)?.parent ?? parent;
    return parent;
  };
  for (const node of nodes.values()) {
    const at = node.purged ? undefined : purgedAt.get(node.parent);
    if (at === undefined) continue;
    node.parent = sourceAbove(node.parent);
    node.arrivedAt = at;
  }
}

/** Whether a restore lifts a delete: the one it `undoes`, or every delete of the node if it undoes none. */
export const lifts = (
  restore: { node: string; undoes?: string },
  entry: { id: string; node: string; from?: string },
) =>
  entry.node === restore.node &&
  (restore.undoes === undefined || entry.id === restore.undoes || entry.from === restore.undoes);

/**
 * A node something may be placed under or done to: its create is in force in the view (the node
 * is in the list), and it was not purged. What Undo and restoring a Discard check before they
 * append a record for a node, and what the replay checks as it reads one.
 */
export function placeIn<Node extends { purged: boolean }>(
  nodes: ReadonlyMap<string, Node>,
  id: string,
): Node | undefined {
  const node = nodes.get(id);
  return node && !node.purged ? node : undefined;
}

type Standing = { deleted: boolean; keptByChild: boolean; keptByPending: boolean; source: string };

/**
 * One pass over the nodes, parents before children on the way down and children before parents
 * on the way up: what is deleted (rules 2 and 7), which deleted folders stand (rule 3) and the
 * names shown (rule 4). Cost follows the number of nodes and what the deletes name, not depth.
 */
function derive(
  nodes: Map<string, Working>,
  deletes: DeleteInForce[],
  pendingOn: Map<string, Set<string>>,
  pendingText: ReadonlySet<string>,
  skipped: TreeProjection["skipped"],
  rescued: string[],
  gone: ReadonlySet<string>,
): Omit<TreeProjection, "dropped"> {
  const children = new Map<string, Working[]>();
  for (const node of nodes.values()) {
    const siblings = children.get(node.parent);
    if (siblings) siblings.push(node);
    else children.set(node.parent, [node]);
  }
  // A delete applies to a node when the node is the delete's own, or a member of its cascade
  // with the delete's node above it.
  const ownedBy = new Map<string, DeleteInForce[]>();
  const takenBy = new Map<string, DeleteInForce[]>();
  for (const entry of deletes) {
    ownedBy.set(entry.node, [...(ownedBy.get(entry.node) ?? []), entry]);
    for (const member of entry.cascade)
      if (nodes.has(member)) takenBy.set(member, [...(takenBy.get(member) ?? []), entry]);
  }
  const pendingNodes = new Set([
    ...[...pendingOn].flatMap(([node, on]) => (on.size > 0 ? [node] : [])),
    ...pendingText,
  ]);

  const standing = new Map<string, Standing>();
  const displayNames = new Map<string, string>();
  const active = new Set<DeleteInForce>();
  type Frame = {
    key: string;
    kids: Working[];
    next: number;
    liveBelow: boolean;
    source: string;
    node?: Working;
  };
  const stack: Frame[] = [];
  const open = (key: string, source: string, node?: Working) =>
    stack.push({ key, kids: children.get(key) ?? [], next: 0, liveBelow: false, source, node });

  for (const root of children.keys()) {
    if (!isSourceRoot(root)) continue;
    open(root, sourceIdOf(root));
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      const child = frame.kids[frame.next];
      if (child) {
        frame.next += 1;
        const mine = ownedBy.get(child.id) ?? [];
        for (const entry of mine) active.add(entry);
        const taken = [...mine, ...(takenBy.get(child.id) ?? [])].filter((entry) =>
          active.has(entry),
        );
        const deleted = taken.length > 0;
        const draftDeleted = taken.some((entry) => entry.own);
        // Rule 7: a delete in live does not take a node this Work has a pending change to,
        // unless the Work deleted it too: it stays in the Work's view, marked.
        const keptByPending = deleted && !draftDeleted && pendingNodes.has(child.id);
        standing.set(child.id, {
          deleted: deleted && !keptByPending,
          keptByChild: false,
          keptByPending,
          source: frame.source,
        });
        open(child.id, frame.source, child);
        continue;
      }
      // Every child has been finished: number the names shown here, then report upward.
      const shown = frame.kids
        .filter((kid) => {
          const state = standing.get(kid.id);
          return !kid.purged && state && (!state.deleted || state.keptByChild);
        })
        // The node already standing keeps its name; the one that arrived later is numbered.
        .sort((a, b) => a.arrivedAt - b.arrivedAt || a.createdAt - b.createdAt);
      const taken = new Set<string>();
      for (const kid of shown) {
        const name = freeName(kid.kind, kid.name, taken);
        taken.add(name);
        displayNames.set(kid.id, name);
      }
      stack.pop();
      const node = frame.node;
      if (!node) continue;
      for (const entry of ownedBy.get(node.id) ?? []) active.delete(entry);
      const state = standing.get(node.id) as Standing;
      // Rule 3: a node nobody deleted keeps every folder above it standing.
      state.keptByChild = state.deleted && frame.liveBelow;
      const parent = stack[stack.length - 1];
      if (parent && (!state.deleted || frame.liveBelow)) parent.liveBelow = true;
    }
  }

  const out = new Map<string, TreeNode>();
  const setters = new Map<string, NodeSetters>();
  for (const node of nodes.values()) {
    const label = node.label[node.label.length - 1];
    const place = node.place[node.place.length - 1];
    if (label || place)
      setters.set(node.id, { ...(label ? { label } : {}), ...(place ? { place } : {}) });
    const state = standing.get(node.id) as Standing;
    out.set(node.id, {
      id: node.id,
      kind: node.kind,
      name: node.name,
      displayName: displayNames.get(node.id) ?? node.name,
      parent: node.parent,
      source: state.source,
      rank: node.rank,
      ...(node.filetype ? { filetype: node.filetype } : {}),
      provisional: node.provisional,
      ...(node.aliases ? { aliases: node.aliases } : {}),
      hasProperties: node.hasProperties,
      trashed: node.purged || (state.deleted && !state.keptByChild),
      keptByChild: state.keptByChild,
      keptByPending: state.keptByPending,
      purged: node.purged,
      ...(node.blob ? { blob: node.blob } : {}),
      createdBy: node.createdBy,
      lastChangedBy: node.lastChangedBy,
      arrival: node.arrivedAt,
    });
  }
  const ordered = new Map<string, TreeNode[]>();
  for (const [parent, kids] of children)
    ordered.set(parent, kids.map((kid) => out.get(kid.id) as TreeNode).sort(byRankThenId));
  const inTrash = deletes.filter(
    (entry) => nodes.has(entry.node) && !nodes.get(entry.node)?.purged,
  );
  // A delete covers the nodes of its cascade whose ancestry still runs through its node: one
  // moved out since (by a move placed before the delete, whose author did not see it) is not.
  const covered = (entry: DeleteInForce) =>
    [...entry.cascade].filter((member) => {
      for (let at = nodes.get(member); at; at = nodes.get(at.parent))
        if (at.id === entry.node) return true;
      return false;
    });
  return {
    nodes: out,
    setters,
    children: ordered,
    skipped,
    rescued,
    gone,
    trash: inTrash.map((entry) => ({
      id: entry.id,
      ...(entry.from ? { from: entry.from } : {}),
      node: entry.node,
      cascade: covered(entry),
    })),
    standingDeletes: new Set(
      inTrash.flatMap((entry) => [
        entry.id,
        entry.from ?? entry.id,
        ...[...entry.putBackBy].flatMap(([root, put]) => (put.size > 0 ? [root] : [])),
      ]),
    ),
  };
}

/** By rank, then id, so equal ranks from concurrent inserts still sort the same everywhere. */
function byRankThenId(a: TreeNode, b: TreeNode): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const isTracked = (type: string | undefined): boolean =>
  type !== undefined && classifyFiletype(type).kind === "tracked";

function schemaOf(type: string): string | null {
  const classification = classifyFiletype(type);
  return classification.kind === "tracked" ? classification.schemaType : null;
}

/**
 * The delete in force that covers a node: its own, else the nearest one above it whose cascade
 * names it. The one reading of "who deleted this" for rows, Trash and the tools; the latest of
 * two deletes of one node answers.
 */
export function deleteCovering(projection: TreeProjection, id: string): TrashEntry | undefined {
  return deletesCovering(projection, id)[0];
}

/**
 * Every delete in force that covers a node, nearest first: its own, then each one above it whose
 * cascade names it, the latest of each node's first. A nearer delete doesn't hide a farther one,
 * so a command can ask whether any delete it made covers the node.
 */
export function deletesCovering(projection: TreeProjection, id: string): TrashEntry[] {
  const out: TrashEntry[] = [];
  for (let at = projection.nodes.get(id); at; at = projection.nodes.get(at.parent)) {
    const node = at.id;
    out.push(
      ...projection.trash
        .filter((each) => each.node === node && (node === id || each.cascade.includes(id)))
        .reverse(),
    );
  }
  return out;
}

/**
 * The records that are one node's item in a view: those made on it, and the delete in force that
 * covers it from a folder above (`deleteCovering`). A delete whose recorded cascade names the node
 * is not among them once the node has left the folder: the cascade is what its author saw.
 */
export function recordsOfItem(
  projection: TreeProjection,
  records: readonly TreeRecord[],
  node: string,
): TreeRecord[] {
  const covering = deleteCovering(projection, node);
  return records.filter(
    (record) => record.node === node || (record.type === "delete" && record.id === covering?.id),
  );
}
