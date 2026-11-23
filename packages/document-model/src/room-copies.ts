import type { LoroDoc, PeerID } from "loro-crdt";
import { type OpSpans, readCommitMessage } from "./commit-message.js";
import { idsAt } from "./copies.js";
import { inText } from "./handles.js";
import type { RoomDocs } from "./room-docs.js";
import type { BlockId } from "./shape.js";
import { StructureView } from "./structure.js";
import { standingSince } from "./take-back.js";
import { type DocVersion, docVersion } from "./version.js";
import type { DocChange } from "./write.js";

type Id = string;
type NodeId = `${BlockId}|${Id}`;
type Op = { from: number; to: number; inserted?: Id[]; deleted?: Id[] };
interface RoomCopyIndex {
  links: Map<NodeId, NodeId>;
  when: Map<NodeId, number>;
  ignored: Map<BlockId, OpSpans>;
  versions: Map<BlockId, DocVersion>;
  deleted: Map<BlockId, Set<NodeId>>;
  deletedVersions: Map<BlockId, DocVersion>;
}

const indices = new WeakMap<RoomDocs, RoomCopyIndex>();

/**
 * Answer copy links across the text docs in one room. A local text-doc answer cannot see that a
 * destination paragraph's character stands for a character in a different paragraph; this pass
 * qualifies every character by its block before applying rules 1 and 3.
 */
export function answerRoomCopies(docs: RoomDocs): DocChange[] {
  const texts = textDocs(docs);
  const index = indices.get(docs) ?? {
    links: new Map(),
    when: new Map(),
    ignored: new Map(),
    versions: new Map(),
    deleted: new Map(),
    deletedVersions: new Map(),
  };
  indices.set(docs, index);
  const { links, when, ignored } = index;
  for (const [block, doc] of texts) {
    for (const change of changesSince(doc, index.versions.get(block))) {
      const note = change.note;
      const runs = note.copy?.for ?? note.undo?.for;
      if (!runs) continue;
      const source = note.copy?.from ?? block;
      const originals = runs.flatMap(([peer, counter, length]) =>
        Array.from({ length }, (_, i) => `${counter + i}@${peer}`),
      );
      let next = 0;
      for (const op of opsIn(doc, change.peer, change.from, change.to)) {
        for (const [offset, id] of (op.inserted ?? []).entries()) {
          const original = originals[next++];
          if (!original) break;
          const destination = node(block, id);
          links.set(destination, node(source, original));
          when.set(destination, change.lamport + op.from + offset - change.from);
        }
      }
      if (note.copy) addSpans(ignored, source, note.copy.ops);
    }
    index.versions.set(block, docVersion(doc));
  }
  if (links.size === 0) return [];

  const deleted = new Set<NodeId>();
  for (const [block, doc] of texts) {
    const version = docVersion(doc);
    if (!sameVersion(index.deletedVersions.get(block), version)) {
      const own = new Set<NodeId>();
      for (const piece of standingSince(doc, new Map()) ?? []) {
        for (const op of opsIn(doc, piece.peer, piece.from, piece.to)) {
          if (op.deleted && ignoredOp(ignored.get(block), piece.peer, op)) continue;
          for (const id of op.deleted ?? []) own.add(node(block, id));
        }
      }
      index.deleted.set(block, own);
      index.deletedVersions.set(block, version);
    }
    for (const id of index.deleted.get(block) ?? []) deleted.add(id);
  }

  const shown: NodeId[] = [];
  for (const [block, doc] of texts)
    if (shownBlock(docs, block))
      for (const id of idsAt(doc, doc.frontiers())) shown.push(node(block, id));

  const go = new Map<BlockId, Set<Id>>();
  const byRoot = new Map<NodeId, NodeId[]>();
  for (const id of shown) {
    const chain = chainOfRoom(links, id);
    if (chain.some((was) => deleted.has(was))) {
      mark(go, id);
      continue;
    }
    if (chain.length === 0) continue;
    const root = chain.at(-1) as NodeId;
    const list = byRoot.get(root);
    if (list) list.push(id);
    else byRoot.set(root, [id]);
  }
  const showing = new Set(shown);
  const later = (a: NodeId, b: NodeId) =>
    (when.get(a) ?? -1) !== (when.get(b) ?? -1)
      ? (when.get(a) ?? -1) > (when.get(b) ?? -1)
      : peerOf(a) > peerOf(b);
  for (const [root, copies] of byRoot) {
    const keep = showing.has(root) ? root : copies.reduce((a, b) => (later(a, b) ? a : b));
    for (const id of copies) if (id !== keep) mark(go, id);
  }
  const changes: DocChange[] = [];
  for (const [block, ids] of go) {
    const own = docs.texts.get(block);
    const doc = own ?? docs.writableText(block).doc;
    const before = doc.frontiers();
    const visible = idsAt(doc, before);
    inText(doc, (text) => {
      for (let pos = visible.length - 1; pos >= 0; pos--)
        if (ids.has(visible[pos])) text.delete(pos, 1);
    });
    doc.commit({ origin: "untracked" });
    if (doc.frontiers().length !== before.length || doc.cmpFrontiers(before, doc.frontiers()) !== 0)
      changes.push({ key: block, doc, before, after: doc.frontiers() });
  }
  return changes;
}

function textDocs(docs: RoomDocs): Map<BlockId, LoroDoc> {
  const out = new Map<BlockId, LoroDoc>();
  for (const [id, doc] of docs.live?.texts ?? []) out.set(id, doc);
  for (const [id, doc] of docs.texts) out.set(id, doc);
  return out;
}

function shownBlock(docs: RoomDocs, id: BlockId): boolean {
  return new StructureView(docs).shown.has(id);
}

function node(block: BlockId, id: Id): NodeId {
  return `${block}|${id}`;
}

function chainOfRoom(links: ReadonlyMap<NodeId, NodeId>, id: NodeId): NodeId[] {
  const chain: NodeId[] = [];
  for (let at = links.get(id); at && !chain.includes(at); at = links.get(at)) chain.push(at);
  return chain;
}

function mark(go: Map<BlockId, Set<Id>>, id: NodeId): void {
  const at = id.indexOf("|");
  const block = id.slice(0, at);
  const char = id.slice(at + 1);
  const ids = go.get(block);
  if (ids) ids.add(char);
  else go.set(block, new Set([char]));
}

function peerOf(id: NodeId): bigint {
  const at = id.lastIndexOf("@");
  return BigInt(id.slice(at + 1));
}

function addSpans(target: Map<BlockId, OpSpans>, block: BlockId, spans: OpSpans): void {
  const into = target.get(block) ?? {};
  for (const [peer, ranges] of Object.entries(spans)) {
    let list = into[peer];
    if (!list) {
      list = [];
      into[peer] = list;
    }
    for (const [from, to] of ranges) {
      const last = list.at(-1);
      if (last && last[1] === from) last[1] = to;
      else list.push([from, to]);
    }
  }
  target.set(block, into);
}

function ignoredOp(spans: OpSpans | undefined, peer: PeerID, op: Op): boolean {
  return spans?.[peer]?.some(([from, to]) => op.from >= from && op.to <= to) ?? false;
}

function changesSince(doc: LoroDoc, since: DocVersion | undefined) {
  const out: {
    peer: PeerID;
    from: number;
    to: number;
    lamport: number;
    note: ReturnType<typeof readCommitMessage>;
  }[] = [];
  for (const [peer, end] of docVersion(doc))
    for (let at = since?.get(peer) ?? 0; at < end; ) {
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

function opsIn(doc: LoroDoc, peer: PeerID, from: number, to: number): Op[] {
  const out: Op[] = [];
  if (to <= from) return out;
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
          from: op.counter,
          to: op.counter + length,
          inserted: Array.from({ length }, (_, i) => `${op.counter + i}@${peer}`),
        });
      } else if (content.type === "delete" && content.start_id && content.len) {
        const first = parseId(content.start_id);
        const length = Math.abs(content.len);
        out.push({
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

function sameVersion(a: DocVersion | undefined, b: DocVersion): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [peer, counter] of b) if (a.get(peer) !== counter) return false;
  return true;
}
