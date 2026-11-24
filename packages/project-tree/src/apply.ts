import { type LoroDoc, VersionVector } from "loro-crdt";
import { listOf } from "./list-doc.js";
import { assertNewCommand } from "./list-index.js";
import {
  type Actor,
  isSourceRoot,
  newId,
  type Settlement,
  sourceRoot,
  type TreeRecord,
} from "./record.js";
import {
  lifts,
  placeIn,
  replay,
  type SkipReason,
  type TreeNode,
  type TreeProjection,
} from "./replay.js";
import { fingerprint } from "./shape.js";
import { type NotUndone, type TakenBack, takeBackAll } from "./undo.js";
import { writable } from "./validate.js";
import { LIVE, lastSettlements, listRecords, pendingRecords, viewRecords } from "./view.js";
import type { TreeWriter } from "./writer.js";

export type LeftWhy = "would_loop" | "purged" | "after_press" | "needs" | "closed";

export type LeftRecord = { record: TreeRecord; why: LeftWhy; source?: string };

export type ApplyResult = {
  command: string;
  copies: TreeRecord[];
  left: LeftRecord[];
  superseded: TreeRecord[];
};

function needs(record: TreeRecord): string[] {
  if (record.type === "create") return [record.parent];
  if (record.type === "move") return [record.node, record.parent];
  return [record.node];
}

type Facts = (record: TreeRecord) => string[];

function factsIn(records: readonly TreeRecord[]): Facts {
  const byRoot = new Map<string, TreeRecord>();
  for (const record of records) {
    const root = record.carries ?? record.id;
    if (!byRoot.has(root)) byRoot.set(root, record);
  }
  return (record) => {
    let base = record;
    for (let up = record.undoes; up !== undefined && base !== byRoot.get(up); ) {
      const next = byRoot.get(up);
      if (!next) break;
      base = next;
      up = next.undoes;
    }
    const sets = base.type === "move" || base.type === "rename" ? base : record;
    if (sets.type === "rename") return [`name:${sets.node}`];
    if (sets.type === "move") return [`place:${sets.node}`];
    if (sets.type === "delete" || sets.type === "restore") return [`presence:${sets.node}`];
    return [`create:${sets.node}`];
  };
}
const sharesFact = (facts: Facts, a: TreeRecord, b: TreeRecord) => {
  const of = facts(b);
  return facts(a).some((fact) => of.includes(fact));
};

function prerequisites(
  pending: readonly TreeRecord[],
  only: readonly string[],
  facts: Facts,
): Set<string> {
  const created = new Map<string, string>();
  for (const record of pending) if (record.type === "create") created.set(record.node, record.id);
  const byId = new Map(pending.map((record) => [record.id, record]));
  const position = new Map(pending.map((record, index) => [record.id, index]));
  const out = new Set<string>();
  const stack = [...only];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const record = byId.get(id);
    if (!record || out.has(id)) continue;
    out.add(id);
    const before = pending.slice(0, position.get(id) ?? 0);
    for (const node of needs(record)) {
      const creator = created.get(node);
      if (creator && creator !== id) stack.push(creator);
    }
    for (const folder of foldersAbove(before, record)) {
      const creator = created.get(folder);
      if (!creator) continue;
      stack.push(creator);
      const presence = before.findLast(
        (earlier) =>
          (earlier.type === "delete" || earlier.type === "restore") && earlier.node === folder,
      );
      if (presence) stack.push(presence.id);
    }
    for (const earlier of before) if (sharesFact(facts, earlier, record)) stack.push(earlier.id);
  }
  return out;
}

function foldersAbove(before: readonly TreeRecord[], record: TreeRecord): Set<string> {
  const parentOf = (node: string) => {
    for (let at = before.length - 1; at >= 0; at--) {
      const earlier = before[at] as TreeRecord;
      if (earlier.node === node && (earlier.type === "create" || earlier.type === "move"))
        return earlier.parent;
    }
    return undefined;
  };
  const out = new Set<string>();
  const starts = [parentOf(record.node)];
  if (record.type === "create" || record.type === "move") starts.push(record.parent);
  for (let folder of starts)
    while (folder !== undefined && !out.has(folder)) {
      out.add(folder);
      folder = parentOf(folder);
    }
  return out;
}

export function dependents(pending: readonly TreeRecord[], only: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...only];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    const record = pending.find((candidate) => candidate.id === id);
    if (!record) continue;
    out.add(id);
    if (record.type !== "create") continue;
    for (const other of pending)
      if (other.id !== id && needs(other).includes(record.node)) stack.push(other.id);
  }
  return out;
}

function keepsView(
  live: readonly TreeRecord[],
  pending: readonly TreeRecord[],
  chosen: ReadonlySet<string>,
  without: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
): boolean {
  const draft = pending[0]?.draft ?? null;
  const rest = pending.filter((record) => !without.has(record.id));
  const view = replay([...live, ...rest], { draft });
  const copies = rest
    .filter((record) => chosen.has(record.id))
    .map((record) => ({ ...record, draft: null, fromDraft: draft ?? undefined }) as TreeRecord);
  const unchosen = rest.filter((record) => !chosen.has(record.id));
  const after = (records: readonly TreeRecord[]) =>
    replay([...live, ...copies, ...records], { draft });
  if (fingerprint(after(unchosen), false) !== fingerprint(view, false)) return false;
  if (waiting.size === 0) return true;
  return (
    standingShape(after(unchosen.filter((record) => !waiting.has(record.id)))) ===
    standingShape(view)
  );
}

const standingShape = (projection: TreeProjection) =>
  fingerprint(projection, false)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("~"))
    .join("\n");

export function recordsAdmittedAfter(doc: LoroDoc, saw: Uint8Array): Set<string> {
  const own = doc.oplogVersion();
  const have = own.toJSON();
  own.free();
  const seen = VersionVector.decode(saw);
  const held = new Map<`${number}`, number>();
  for (const [peer, counter] of seen.toJSON()) {
    const shared = Math.min(counter, have.get(peer) ?? 0);
    if (shared > 0) held.set(peer, shared);
  }
  seen.free();
  const at = new VersionVector(held);
  const then = doc.forkAt(doc.vvToFrontiers(at));
  at.free();
  try {
    const had = new Set(listRecords(then).map((record) => record.id));
    return new Set(listRecords(doc).flatMap((record) => (had.has(record.id) ? [] : [record.id])));
  } finally {
    then.free();
  }
}

const whyNotInView = (reason: SkipReason): LeftWhy =>
  reason === "cycle" ? "would_loop" : GONE.has(reason) ? "purged" : "needs";

export function applyDraft(
  writer: TreeWriter,
  draft: string,
  appliedBy: Actor,
  command: string,
  only?: readonly string[],
  saw?: Uint8Array,
  closed?: (source: string) => boolean,
): ApplyResult {
  const { doc } = writer;
  assertNewCommand(doc, command);
  const view = writer.view({ draft });
  const pending = pendingRecords(doc, draft);
  const pendingIds = new Set(pending.map((record) => record.id));
  const live = viewRecords(doc, LIVE);
  const roots = new Map<string, LeftWhy>();
  for (const skip of view.skipped)
    if (pendingIds.has(skip.record)) roots.set(skip.record, whyNotInView(skip.reason));
  if (saw)
    for (const id of recordsAdmittedAfter(doc, saw))
      if (pendingIds.has(id) && !roots.has(id)) roots.set(id, "after_press");
  const facts = factsIn(listRecords(doc));
  const liveNow = writer.view(LIVE);
  const waiting = new Set(
    pending.flatMap((record) =>
      (record.type === "move" || record.type === "rename") &&
      view.nodes.get(record.node)?.trashed &&
      liveNow.nodes.get(record.node)?.trashed
        ? [record.id]
        : [],
    ),
  );
  const wanted = new Set(
    [...(only ? prerequisites(pending, only, facts) : pendingIds)].filter((id) => !waiting.has(id)),
  );
  const closedBy = new Map<string, string>();
  const plan = () => {
    const leftIds = dependents(pending, [...roots.keys()]);
    const heldIds = dependents(pending, [...closedBy.keys()]);
    const unplanned = new Set([...leftIds, ...waiting]);
    const candidates = pending.filter(
      (record) => wanted.has(record.id) && !unplanned.has(record.id),
    );
    const chosenOf = (records: readonly TreeRecord[]) =>
      new Set(records.map((record) => record.id));

    const pool = (() => {
      if (candidates.length === 0) return [];
      if (keepsView(live, pending, chosenOf(candidates), leftIds, waiting)) return candidates;
      const last = pending.indexOf(candidates[candidates.length - 1] as TreeRecord);
      return pending.slice(0, last + 1).filter((record) => !unplanned.has(record.id));
    })();
    const holds = (count: number) =>
      keepsView(live, pending, chosenOf(pool.slice(0, count)), leftIds, waiting);
    let count = pool.length;
    if (count > 0 && pool !== candidates && !holds(count)) {
      let good = 0;
      let bad = count;
      while (bad - good > 1) {
        const mid = (good + bad) >> 1;
        if (holds(mid)) good = mid;
        else bad = mid;
      }
      count = good;
    }
    const already = pool.slice(0, count).filter((record) => {
      const node = record.type === "create" ? liveNow.nodes.get(record.node) : undefined;
      return node?.trashed === false && !node.keptByChild;
    });
    const taken = chosenOf(pool.slice(0, count).filter((record) => !already.includes(record)));
    const superseded = pending.filter((record) => {
      if (!leftIds.has(record.id) || heldIds.has(record.id) || taken.size === 0) return false;
      const overriding = new Set(
        pending
          .slice(pending.indexOf(record) + 1)
          .filter((later) => taken.has(later.id))
          .flatMap(facts),
      );
      return facts(record).every((fact) => overriding.has(fact));
    });
    const overridden = new Set([...superseded, ...already].map((record) => record.id));
    const was = new Map<string, { name: string; parent: string; rank: string }>();
    const turned = new Set<string>();
    const stands = (node: string) => {
      if (turned.delete(node)) {
        const now = replay([...live, ...copies]).nodes.get(node);
        if (now) was.set(node, now);
      }
      return was.get(node) ?? liveNow.nodes.get(node);
    };
    const copies: TreeRecord[] = [];
    const ofCopy = new Map<string, string>();
    for (const record of pending) {
      if (!taken.has(record.id)) continue;
      const copy = {
        ...record,
        id: newId(),
        draft: null,
        carries: record.carries ?? record.id,
        appliedBy,
        fromDraft: draft,
      } as TreeRecord;
      const before = stands(copy.node);
      if (copy.type === "move" && before) copy.from = { parent: before.parent, rank: before.rank };
      if (copy.type === "rename" && before) copy.fromName = before.name;
      if (copy.undoes !== undefined) turned.add(copy.node);
      else if (copy.type === "create")
        was.set(copy.node, { name: copy.name, parent: copy.parent, rank: copy.rank });
      else if (before && copy.type === "move")
        was.set(copy.node, {
          name: before.name,
          parent: copy.parent,
          rank: copy.rank,
        });
      else if (before && copy.type === "rename") was.set(copy.node, { ...before, name: copy.name });
      copies.push(writable(copy));
      ofCopy.set(copy.id, record.id);
    }
    return { taken, superseded, already, overridden, copies, ofCopy };
  };
  let landing = plan();
  while (closed) {
    const projection = replay([...live, ...landing.copies]);
    const offender = landing.copies.find((copy) =>
      projection.changes.get(copy.id)?.sources.some(closed),
    );
    if (!offender) break;
    const source = projection.changes.get(offender.id)?.sources.find(closed) as string;
    const original = landing.ofCopy.get(offender.id);
    if (!original) throw new Error("Apply copy has no pending record");
    roots.set(original, "closed");
    closedBy.set(original, source);
    landing = plan();
  }
  const { taken, superseded, already, overridden, copies } = landing;
  writer.transact(() => {
    listOf(doc).pushRecords(copies);
    writer.settle(appliedBy, [...taken], "applied", { command });
    writer.settle(appliedBy, [...overridden], "superseded", { command });
  });
  const held = new Map<string, string>();
  for (const [id, source] of closedBy)
    for (const dependent of dependents(pending, [id]))
      if (!held.has(dependent)) held.set(dependent, source);
  return {
    command,
    copies,
    left: pending.flatMap((record) =>
      wanted.has(record.id) && !taken.has(record.id) && !overridden.has(record.id)
        ? [
            held.has(record.id)
              ? { record, why: "closed" as const, source: held.get(record.id) }
              : { record, why: roots.get(record.id) ?? ("needs" as const) },
          ]
        : [],
    ),
    superseded: [...superseded, ...already],
  };
}

export function discardDraft(
  writer: TreeWriter,
  draft: string,
  by: Actor,
  command: string,
  only?: readonly string[],
  options: { trash?: boolean } = {},
): { discarded: string[]; trashed: string[] } {
  assertNewCommand(writer.doc, command);
  const pending = pendingRecords(writer.doc, draft);
  const chosen = only ? dependents(pending, only) : new Set(pending.map((record) => record.id));
  const made = options.trash
    ? toTrash(
        writer,
        draft,
        by,
        pending.filter((record) => chosen.has(record.id) && record.type === "create"),
      )
    : [];
  writer.transact(() => {
    writer.settle(by, [...chosen], "discarded", { command });
    if (made.length > 0) listOf(writer.doc).pushRecords(made);
  });
  return {
    discarded: [...chosen],
    trashed: made.flatMap((record) => (record.type === "delete" ? [record.id] : [])),
  };
}

function toTrash(
  writer: TreeWriter,
  draft: string,
  by: Actor,
  creates: readonly TreeRecord[],
): TreeRecord[] {
  const view = writer.view({ draft });
  const live = writer.view(LIVE);
  const going = new Set(
    creates.flatMap((record) => {
      const node = placeIn(view.nodes, record.node);
      return node && !node.trashed && !live.nodes.has(record.node) ? [record.node] : [];
    }),
  );
  const below = (id: string): string[] =>
    (view.children.get(id) ?? []).flatMap((child) =>
      going.has(child.id) ? [child.id, ...below(child.id)] : [],
    );
  const made: TreeRecord[] = [];
  for (const top of going) {
    if (going.has(view.nodes.get(top)?.parent as string)) continue;
    const held = below(top);
    for (const id of [top, ...held]) {
      const node = view.nodes.get(id) as TreeNode;
      const create = creates.find((record) => record.node === id) as TreeRecord;
      const parent =
        id !== top || isSourceRoot(node.parent) || placeIn(live.nodes, node.parent)
          ? node.parent
          : sourceRoot(node.source);
      made.push(
        writer.prepare(
          LIVE,
          create.actor,
          {
            type: "create",
            node: id,
            kind: node.kind,
            name: node.name,
            parent,
            source: node.source,
            rank: node.rank,
            ...(node.filetype ? { filetype: node.filetype } : {}),
            ...(node.provisional ? { provisional: true as const } : {}),
            ...(node.aliases ? { aliases: node.aliases } : {}),
            ...(node.hasProperties ? { hasProperties: true as const } : {}),
            ...(node.blob ? { blob: node.blob } : {}),
          },
          { carries: create.carries ?? create.id, fromDraft: draft },
        ),
      );
    }
    made.push(writer.prepare(LIVE, by, { type: "delete", node: top, cascade: held }));
  }
  return made;
}

const GONE: ReadonlySet<SkipReason> = new Set(["purged", "missing-node", "missing-parent"]);

function appliedBy(doc: LoroDoc, applied: string) {
  const settled = settledBy(doc, applied, "applied", "superseded");
  const all = new Map(listRecords(doc).map((record) => [record.id, record]));
  const landed = new Set(
    settled.flatMap(([id, to]) => {
      const record = all.get(id);
      return to === "applied" && record ? [record.carries ?? record.id] : [];
    }),
  );
  const last = new Map<string, TreeRecord>();
  for (const record of viewRecords(doc, LIVE))
    if (record.carries !== undefined && landed.has(record.carries))
      last.set(record.carries, record);
  const copies = viewRecords(doc, LIVE).filter(
    (record) => record.carries !== undefined && last.get(record.carries) === record,
  );
  return { settled, copies };
}

export function madeBy(doc: LoroDoc, applied: string): TreeRecord[] {
  return appliedBy(doc, applied).copies;
}

export type UndoLeftWhy = NotUndone | "closed";

export type UndoApplyResult = {
  undone: TreeRecord[];
  left: Array<{ record: TreeRecord; why: UndoLeftWhy; source?: string }>;
};

export function undoApply(
  writer: TreeWriter,
  applied: string,
  by: Actor,
  command: string,
  options: { closed?: (source: string) => boolean } = {},
): UndoApplyResult {
  assertNewCommand(writer.doc, command);
  const { settled } = appliedBy(writer.doc, applied);
  const made = madeBy(writer.doc, applied);
  const undone: TreeRecord[] = [];
  const left: UndoApplyResult["left"] = [];
  const reversed = new Set<string>();
  writer.transact(() => {
    const copies = made.reverse();
    const answers = takeBackAll(
      writer,
      by,
      copies.map((copy) => ({ id: copy.id, view: LIVE, withdraw: copy.fromDraft })),
      options.closed,
    );
    for (const copy of copies) {
      const back = answers.get(copy.id) as TakenBack;
      if (typeof back === "string") {
        left.push({ record: copy, why: back });
        continue;
      }
      if ("closed" in back) {
        left.push({ record: copy, why: "closed", source: back.closed });
        continue;
      }
      undone.push(back);
      reversed.add(copy.carries ?? copy.id);
    }
    const all = listRecords(writer.doc);
    const facts = factsIn(all);
    const position = new Map(all.map((record, at) => [record.id, at]));
    const byId = new Map(all.map((record) => [record.id, record]));
    const rootOf = (id: string) => byId.get(id)?.carries ?? id;
    const reopened = settled.flatMap(([id, to]) =>
      to === "applied" && reversed.has(rootOf(id)) ? [id] : [],
    );
    const back = settled.flatMap(([id, to]) => {
      if (to === "applied") return reopened.includes(id) ? [id] : [];
      const lost = byId.get(id);
      return lost &&
        reopened.some((other) => {
          const record = byId.get(other);
          return (
            record &&
            (position.get(other) ?? 0) > (position.get(id) ?? 0) &&
            sharesFact(facts, lost, record)
          );
        })
        ? [id]
        : [];
    });
    writer.settle(by, back, "pending", { command });
  });
  return { undone, left };
}

export type DiscardedBy = {
  records: TreeRecord[];
  restored: boolean;
};

export function discardedBy(doc: LoroDoc, discarded: string): DiscardedBy {
  const last = lastSettlements(doc);
  const all = listRecords(doc);
  const records = all.filter((record) => {
    const settle = last.get(record.id);
    return settle?.to === "discarded" && settle.command === discarded;
  });
  return { records, restored: all.some((record) => record.restores === discarded) };
}

export function restoreDiscard(
  writer: TreeWriter,
  discarded: string,
  by: Actor,
  draft: string,
  command: string,
  trashed: readonly string[] = [],
): { copies: TreeRecord[]; back: TreeRecord[] } | "already" {
  const { doc } = writer;
  assertNewCommand(doc, command);
  const { records: settled, restored } = discardedBy(doc, discarded);
  const deletes = listRecords(doc).filter(
    (record) => record.type === "delete" && trashed.includes(record.id),
  );
  if ((restored || settled.length === 0) && deletes.length === 0) return "already";
  const live = writer.view(LIVE);
  const trash = live.trash.filter((entry) => trashed.includes(entry.id));
  const covered = new Set(trash.flatMap((entry) => [entry.node, ...entry.cascade]));
  const stays = new Set(
    deletes.flatMap((record) =>
      record.type === "delete"
        ? [record.node, ...record.cascade].filter((node) => !covered.has(node))
        : [],
    ),
  );
  for (const node of [...stays]) {
    let at = live.nodes.get(node)?.parent;
    while (at !== undefined && covered.has(at)) {
      stays.add(at);
      at = live.nodes.get(at)?.parent;
    }
  }
  const going = new Set([...covered].filter((node) => !stays.has(node)));
  const records = restored ? [] : settled.filter((record) => !stays.has(record.node));
  const view = writer.view({ draft });
  const created = new Set(
    records.flatMap((record) => (record.type === "create" ? [record.node] : [])),
  );
  const copies: TreeRecord[] = [];
  for (const record of records) {
    if (created.has(record.node) || placeIn(view.nodes, record.node))
      copies.push(
        writable({
          ...record,
          id: newId(),
          draft,
          carries: record.carries ?? record.id,
          restores: discarded,
          restoredBy: by,
        } as TreeRecord),
      );
  }
  const overrides = (copy: TreeRecord, pending: TreeRecord) =>
    copy.type === "restore"
      ? pending.type === "delete" &&
        lifts(copy, { id: pending.id, node: pending.node, from: pending.carries })
      : copy.node === pending.node &&
        (copy.type === "rename" || copy.type === "move") &&
        pending.type === copy.type;
  const overridden = pendingRecords(doc, draft)
    .filter((pending) => copies.some((copy) => overrides(copy, pending)))
    .map((pending) => pending.id);
  const back: TreeRecord[] = [];
  writer.transact(() => {
    writer.settle(by, overridden, "discarded", { command });
    listOf(doc).pushRecords(copies);
    const answers = takeBackAll(writer, by, [
      ...trash.map((entry) => ({ id: entry.id, view: LIVE })),
      ...records
        .filter((record) => record.type === "create" && going.has(record.node))
        .reverse()
        .map((record) => ({ id: record.id, view: LIVE, withdraw: draft })),
    ]);
    for (const answer of answers.values())
      if (typeof answer === "object" && "id" in answer) back.push(answer);
  });
  return { copies, back };
}

function settledBy(doc: LoroDoc, command: string, ...to: Settlement[]) {
  return [...lastSettlements(doc)]
    .filter(([, settle]) => settle.command === command && to.includes(settle.to))
    .map(([id, settle]) => [id, settle.to] as const);
}
