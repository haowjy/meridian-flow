import type { Frontiers, LoroDoc, PeerID } from "loro-crdt";
import { readCommitMessage, type StandsFor } from "./commit-message.js";
import { inText } from "./handles.js";
import { TEXT_KEY } from "./shape.js";
import { standingSince, type TextOp, textDiff } from "./take-back.js";
import { docVersion, withVector } from "./version.js";
import type { DocChange } from "./write.js";

type Id = string;
type Op = { peer: PeerID; from: number; to: number; inserted?: Id[]; deleted?: Id[] };

/** The ids showing at a text frontier, in display order. */
export function idsAt(doc: LoroDoc, frontiers: Frontiers): Id[] {
  const view = doc.fork();
  try {
    view.checkout(frontiers);
    return inText(view, (text) => {
      const ids: Id[] = [];
      for (let pos = 0; pos < text.length; pos++) {
        const cursor = text.getCursor(pos, 0);
        if (!cursor) continue;
        try {
          const id = cursor.pos();
          if (id) ids.push(`${id.counter}@${id.peer}`);
        } finally {
          cursor.free();
        }
      }
      return ids;
    });
  } finally {
    view.free();
  }
}

/** Every op in a peer's counter range, represented by the character ids it inserts/deletes. */
function opsIn(doc: LoroDoc, peer: PeerID, from: number, to: number): Op[] {
  if (to <= from) return [];
  const out: Op[] = [];
  for (const change of doc.exportJsonInIdSpan({ peer, counter: from, length: to - from }))
    for (const op of change.ops) {
      const content = op.content as {
        type: string;
        text?: string;
        start_id?: string;
        len?: number;
      };
      if (content.type === "insert" && typeof content.text === "string") {
        const length = [...content.text].length;
        out.push({
          peer,
          from: op.counter,
          to: op.counter + length,
          inserted: Array.from({ length }, (_, i) => `${op.counter + i}@${peer}`),
        });
      } else if (content.type === "delete" && content.start_id && content.len) {
        const first = parseId(content.start_id);
        const length = Math.abs(content.len);
        out.push({
          peer,
          from: op.counter,
          to: op.counter + length,
          deleted: Array.from({ length }, (_, i) => `${first.counter + i}@${first.peer}`),
        });
      }
    }
  return out;
}

function parseId(id: Id): { counter: number; peer: PeerID } {
  const at = id.indexOf("@");
  return { counter: Number(id.slice(0, at)), peer: id.slice(at + 1) as PeerID };
}

function changesSince(doc: LoroDoc) {
  const out: {
    peer: PeerID;
    from: number;
    to: number;
    lamport: number;
    note: ReturnType<typeof readCommitMessage>;
  }[] = [];
  for (const [peer, end] of docVersion(doc))
    for (let at = 0; at < end; ) {
      const change = doc.getChangeAt({ peer, counter: at });
      if (!change) break;
      const to = change.counter + change.length;
      out.push({
        peer,
        from: at,
        to,
        lamport: change.lamport + at - change.counter,
        note: readCommitMessage(change.message),
      });
      at = to;
    }
  return out;
}

function standsFor(doc: LoroDoc, when: Map<Id, number>): Map<Id, Id> {
  const links = new Map<Id, Id>();
  for (const change of changesSince(doc)) {
    const runs = change.note.undo?.for ?? change.note.copy?.for;
    if (!runs) continue;
    const originals = runs.flatMap(([peer, counter, length]) =>
      Array.from({ length }, (_, i) => `${counter + i}@${peer}`),
    );
    let n = 0;
    for (const op of opsIn(doc, change.peer, change.from, change.to))
      for (const [i, id] of (op.inserted ?? []).entries()) {
        if (n >= originals.length) break;
        links.set(id, originals[n++]);
        when.set(id, change.lamport + op.from + i - change.from);
      }
  }
  return links;
}

/** The original id and every copied id in its chain. */
export function chainOf(links: ReadonlyMap<Id, Id>, id: Id): Id[] {
  const chain: Id[] = [];
  for (let at = links.get(id); at && !chain.includes(at); at = links.get(at)) chain.push(at);
  return chain;
}

/** Delete duplicate/dead copies on one text doc. Returns the local answer, if one was written. */
export function oneCopy(
  doc: LoroDoc,
  key: string = TEXT_KEY,
): { change: DocChange | null; removed: number } {
  const when = new Map<Id, number>();
  const links = standsFor(doc, when);
  if (links.size === 0) return { change: null, removed: 0 };
  // A concurrent delete cannot have followed a copy it had not seen. It remains a delete of the
  // original character, but it must not erase the Undo copy that restores that character.
  const deleted = new Map<Id, number>();
  for (const piece of standingSince(doc, new Map()) ?? [])
    for (const op of opsIn(doc, piece.peer, piece.from, piece.to))
      for (const id of op.deleted ?? []) deleted.set(id, piece.lamport + op.from - piece.from);
  const shown = idsAt(doc, doc.frontiers());
  const showing = new Set(shown);
  const go = new Set<Id>();
  const byRoot = new Map<Id, Id[]>();
  for (const id of shown) {
    const chain = chainOf(links, id);
    if (chain.length === 0) continue;
    if (chain.some((was) => (deleted.get(was) ?? -1) > (when.get(id) ?? -1))) {
      go.add(id);
      continue;
    }
    const root = chain.at(-1) as Id;
    const copies = byRoot.get(root);
    if (copies) copies.push(id);
    else byRoot.set(root, [id]);
  }
  const later = (a: Id, b: Id) =>
    (when.get(a) ?? -1) !== (when.get(b) ?? -1)
      ? (when.get(a) ?? -1) > (when.get(b) ?? -1)
      : BigInt(parseId(a).peer) > BigInt(parseId(b).peer);
  for (const [root, copies] of byRoot) {
    const keep = showing.has(root) ? root : copies.reduce((a, b) => (later(a, b) ? a : b));
    for (const id of copies) if (id !== keep) go.add(id);
  }
  if (go.size === 0) return { change: null, removed: 0 };
  const before = doc.frontiers();
  inText(doc, (text) => {
    for (let pos = shown.length - 1; pos >= 0; pos--) if (go.has(shown[pos])) text.delete(pos, 1);
  });
  doc.commit({ origin: "untracked" });
  return { change: { key, doc, before, after: doc.frontiers() }, removed: go.size };
}

function minVersion(a: ReadonlyMap<PeerID, number>, b: ReadonlyMap<PeerID, number>) {
  const out = new Map<PeerID, number>();
  for (const [peer, counter] of a) {
    const n = Math.min(counter, b.get(peer) ?? 0);
    if (n > 0) out.set(peer, n);
  }
  return out;
}

function hunksOf(delta: readonly TextOp[]) {
  const out: { at: number; deleted: number; to: number; inserted: number }[] = [];
  let before = 0;
  let after = 0;
  let open: (typeof out)[number] | undefined;
  for (const op of delta) {
    if (op.retain != null) {
      before += op.retain;
      after += op.retain;
      open = undefined;
      continue;
    }
    if (!open) {
      open = { at: before, deleted: 0, to: after, inserted: 0 };
      out.push(open);
    }
    if (op.delete != null) {
      open.deleted += op.delete;
      before += op.delete;
    } else {
      open.inserted += (op.insert as string).length;
      after += (op.insert as string).length;
    }
  }
  return out;
}

function runsOf(ids: readonly Id[]): StandsFor {
  const out: StandsFor = [];
  for (const id of ids) {
    const { peer, counter } = parseId(id);
    const last = out.at(-1);
    if (last && last[0] === peer && last[1] + last[2] === counter) last[2]++;
    else out.push([peer, counter, 1]);
  }
  return out;
}

function addSpan(out: Record<string, [number, number][]>, peer: PeerID, from: number, to: number) {
  const spans = out[peer] ?? [];
  if (!out[peer]) out[peer] = spans;
  const last = spans.at(-1);
  if (last && last[1] === from) last[1] = to;
  else spans.push([from, to]);
}

/** Bring one forked text doc forward and apply rules 1, 3 and 4. */
export function forwardText(
  fork: LoroDoc,
  live: LoroDoc,
  key: string = TEXT_KEY,
): { imported: boolean; changes: DocChange[] } {
  const had = minVersion(docVersion(fork), docVersion(live));
  const before = fork.frontiers();
  const update = withVector(docVersion(fork), (from) => live.export({ mode: "update", from }));
  const status = fork.import(update);
  const after = fork.frontiers();
  const changes: DocChange[] = [];
  if (status.pending || sameFrontiers(before, after)) return { imported: false, changes };

  const liveWas = withVector(had, (vector) => fork.vvToFrontiers(vector));
  const draftDelta = textDiff(fork, liveWas, before);
  const links = standsFor(fork, new Map());
  if (!draftDelta.some((op) => op.delete != null) && links.size === 0)
    return { imported: true, changes };
  if (!draftDelta.some((op) => op.delete != null)) {
    const answer = oneCopy(fork, key);
    if (answer.change) changes.push(answer.change);
    return { imported: true, changes };
  }
  const liveNow = live.frontiers();
  const wasIds = idsAt(fork, liveWas);
  const nowIds = idsAt(fork, liveNow);
  const rootOf = (id: Id) => chainOf(links, id).at(-1) ?? id;
  const shownRoots = new Set(idsAt(fork, before).map(rootOf));
  const draftDeleted = new Set<Id>();
  for (const hunk of hunksOf(draftDelta))
    for (let i = 0; i < hunk.deleted; i++) {
      const id = wasIds[hunk.at + i];
      if (id && !shownRoots.has(rootOf(id))) draftDeleted.add(id);
    }
  const keptOut = new Set<Id>();
  for (const change of standingSince(fork, new Map()) ?? [])
    if (change.note.clash)
      for (const spans of Object.values(change.note.undo?.ops ?? {}))
        for (const [from, to] of spans)
          for (const op of opsIn(fork, change.peer, from, to))
            for (const id of op.inserted ?? []) if (!links.has(id)) keptOut.add(id);

  const out = new Set<Id>();
  const back = new Set<Id>();
  for (const hunk of hunksOf(textDiff(fork, liveWas, liveNow))) {
    if (hunk.inserted === 0) continue;
    const removed = wasIds.slice(hunk.at, hunk.at + hunk.deleted);
    const left = wasIds[hunk.at - 1];
    const right = wasIds[hunk.at + hunk.deleted];
    const clash =
      removed.some((id) => draftDeleted.has(id)) ||
      (hunk.deleted === 0 &&
        !!left &&
        !!right &&
        draftDeleted.has(left) &&
        draftDeleted.has(right)) ||
      (!!left && keptOut.has(left)) ||
      (!!right && keptOut.has(right));
    if (!clash) continue;
    for (let i = 0; i < hunk.inserted; i++) {
      const id = nowIds[hunk.to + i];
      if (id) out.add(id);
    }
    for (const id of removed) back.add(id);
  }
  if (out.size > 0 || back.size > 0) {
    const wasFork = idsAt(fork, before);
    const nowFork = idsAt(fork, after);
    const delta: TextOp[] = [];
    const put: Id[] = [];
    let a = 0;
    let b = 0;
    const retain = (n: number) => {
      const last = delta.at(-1);
      if (last?.retain != null && !last.attributes) (last as { retain: number }).retain += n;
      else delta.push({ retain: n });
    };
    for (const op of textDiff(fork, after, before)) {
      if (op.retain != null) {
        retain(op.retain);
        a += op.retain;
        b += op.retain;
      } else if (op.delete != null) {
        for (let i = 0; i < op.delete; i++)
          nowFork[a + i] && out.has(nowFork[a + i]) ? delta.push({ delete: 1 }) : retain(1);
        a += op.delete;
      } else {
        for (let i = 0; i < (op.insert as string).length; i++) {
          if (!back.has(wasFork[b + i])) continue;
          delta.push({
            insert: (op.insert as string)[i],
            ...(op.attributes ? { attributes: op.attributes } : {}),
          } as TextOp);
          put.push(wasFork[b + i]);
        }
        b += (op.insert as string).length;
      }
    }
    const ops: Record<string, [number, number][]> = {};
    for (const [peer, end] of docVersion(live))
      for (const op of opsIn(fork, peer, had.get(peer) ?? 0, end)) {
        if (
          (op.inserted ?? []).some((id) => out.has(id)) ||
          (op.deleted ?? []).some((id) => back.has(id))
        )
          addSpan(ops, peer, op.from, op.to);
      }
    const message = JSON.stringify({ undo: { for: runsOf(put), ops }, clash: true });
    const head = fork.frontiers();
    inText(fork, (text) => text.applyDelta(delta));
    fork.commit({ message });
    changes.push({ key, doc: fork, before: head, after: fork.frontiers() });
  }
  const answer = oneCopy(fork, key);
  if (answer.change) changes.push(answer.change);
  return { imported: true, changes };
}

function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  return (
    a.length === b.length &&
    a.every((id) => b.some((other) => other.peer === id.peer && other.counter === id.counter))
  );
}
