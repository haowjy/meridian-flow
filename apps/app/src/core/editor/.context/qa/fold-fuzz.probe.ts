// @vitest-environment jsdom
/**
 * Probe: random concurrent editing against the patched y-tiptap binding. Two or three real TipTap
 * editors, each on its own `Y.Doc`, type, delete, move blocks, bold and align while a server peer writes into
 * the same paragraphs through agent-edit (`writeBlocks` and `applyOps`),
 * with updates delivered through the server at random times. Run it by hand when the y-tiptap patch, the binding or
 * agent-edit's writer changes: see fold-fuzz.md beside this file.
 */
import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import { yProsemirrorModel } from "@meridian/agent-edit/integration";
import { Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import { DocumentHistory } from "@/core/editor/editor-history";
import { createLocalPresence } from "@/core/editor/local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 100);
const STEPS = Number(process.env.FUZZ_STEPS ?? 120);

const editors: Editor[] = [];
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});
afterEach(() => {
  for (const e of editors.splice(0)) if (!e.isDestroyed) e.destroy();
  vi.unstubAllGlobals();
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Each character's Yjs client (the byline the merge must keep with it) and its block's id. */
function owners(doc: Y.Doc): Map<string, { client: number; block: unknown }> {
  const out = new Map<string, { client: number; block: unknown }>();
  const walk = (t: unknown, block: unknown) => {
    if (t instanceof Y.XmlText) {
      for (let n = t._start; n; n = n.right)
        if (!n.deleted && n.content instanceof Y.ContentString)
          for (const ch of n.content.str) out.set(ch, { client: n.id.client, block });
    } else if (t instanceof Y.XmlElement) t.forEach((c) => walk(c, t.getAttribute("id")));
  };
  doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).forEach((b) => walk(b, null));
  return out;
}

function run(seed: number, editorCount: number) {
  const r = rng(seed);
  // Client ids and block ids come from the seed, so a seed replays the same run.
  const ids = rng(seed + 1_000_003);
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(ids() * 256);
    return array;
  });
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)] as T;
  const seedDoc = new Y.Doc({ gc: false });
  seedDoc.clientID = seed * 10;
  const first = new Y.XmlElement("paragraph");
  first.setAttribute("id", "seed");
  seedDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [first]);
  const base = Y.encodeStateAsUpdate(seedDoc);

  const docs: Y.Doc[] = [];
  const peerEditors: Editor[] = [];
  for (let i = 0; i < editorCount; i++) {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = seed * 10 + 1 + i;
    Y.applyUpdate(doc, base);
    const editor = new Editor({
      element: document.createElement("div"),
      ...createEditorConfig({
        document: doc,
        history: DocumentHistory.forDocument(doc),
        presence: createLocalPresence(new Awareness(doc)),
        showCollaborationDecorations: false,
      }),
    });
    editors.push(editor);
    docs.push(doc);
    peerEditors.push(editor);
  }
  const server = new Y.Doc({ gc: false });
  server.clientID = seed * 10 + 9;
  Y.applyUpdate(server, base);
  docs.push(server);
  const schema = peerEditors[0]!.state.schema;

  // A star, as in the app: an editor talks only to the server, and the server relays every
  // update it applies to the other editors. Each link delivers in order.
  const serverIndex = docs.length - 1;
  const outbox: Uint8Array[][][] = docs.map(() => docs.map(() => []));
  docs.forEach((doc, i) =>
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (i !== serverIndex) {
        if (origin !== "net") outbox[i]![serverIndex]!.push(u);
        return;
      }
      docs.forEach((_, j) => {
        if (j !== serverIndex && j !== origin) outbox[serverIndex]![j]!.push(u);
      });
    }),
  );
  const deliver = (i: number, j: number) => {
    for (const u of outbox[i]![j]!.splice(0)) Y.applyUpdate(docs[j]!, u, j === serverIndex ? i : "net");
  };
  const deliverRandom = () => {
    const editorIndex = Math.floor(r() * editorCount);
    if (r() < 0.5) deliver(editorIndex, serverIndex);
    else deliver(serverIndex, editorIndex);
  };

  const typedBy = new Map<string, number>();
  // Yjs has no move: a moved block is re-created, so typing a peer put in it concurrently is lost
  // by design and its byline goes to the mover. Those characters are not counted.
  const typedIn = new Map<string, unknown>();
  const moved = new Set<unknown>();
  const deleted = new Set<string>();
  let counter = 0;
  let rebuilt = 0;
  const nextChar = () => String.fromCharCode(0x4e00 + counter++);
  const blocks = (e: Editor) => {
    const out: { pos: number; size: number; node: PMNode }[] = [];
    e.state.doc.forEach((node, pos) => out.push({ pos, size: node.nodeSize, node }));
    return out;
  };

  for (let s = 0; s < STEPS; s++) {
    const who = Math.floor(r() * docs.length);
    const editor = peerEditors[who];
    if (!editor) {
      if (r() >= 0.5) {
        deliverRandom();
        continue;
      }
      const frag = server.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      const current = readBlocks(frag, schema);
      const idx = Math.floor(r() * current.length);
      const block = current[idx]!;
      if (block.type.name !== "paragraph") continue;
      const c = nextChar();
      typedBy.set(c, who);
      typedIn.set(c, block.attrs.id);
      const text = block.textContent;
      const at = Math.min(2 * Math.floor(r() * (block.content.size / 2 + 1)), text.length);
      const marks = block.content.size > 0 ? block.firstChild!.marks : [];
      const next = schema.nodes.paragraph!.create(
        block.attrs,
        schema.text(`${text.slice(0, at)}${c} ${text.slice(at)}`, marks),
      );
      if (r() < 0.6) {
        const stats = writeBlocks(frag, schema, current.map((x, k) => (k === idx ? next : x)));
        rebuilt += stats.inserted + stats.deleted;
      } else {
        const model = yProsemirrorModel(schema);
        const splice = { from: at, to: at, content: Fragment.from(schema.text(`${c} `, marks)) };
        model.applyOps(server as never, model.getBlocks(server as never)[idx]!, [
          { kind: "text", path: [], splices: [splice], formats: [] },
        ]);
      }
      continue;
    }

    const { view, state } = editor;
    const { schema: own } = state; // each editor has its own schema; a foreign MarkType never merges
    const op = r();
    const paragraphs = blocks(editor).filter((b) => b.node.type.name === "paragraph");
    if (op < 0.5 && paragraphs.length) {
      const b = pick(paragraphs);
      const off = 2 * Math.floor(r() * (b.node.content.size / 2 + 1));
      const c = nextChar();
      view.dispatch(state.tr.insertText(`${c} `, b.pos + 1 + off));
      typedBy.set(c, who);
      typedIn.set(c, b.node.attrs.id);
    } else if (op < 0.6) {
      const b = pick(blocks(editor));
      view.dispatch(state.tr.insert(r() < 0.5 ? b.pos : b.pos + b.size, own.nodes.paragraph!.create()));
    } else if (op < 0.7 && paragraphs.length) {
      const b = pick(paragraphs);
      if (b.node.content.size > 0) {
        const a = 2 * Math.floor(r() * (b.node.content.size / 2));
        const z = Math.min(b.node.content.size, a + 2);
        for (const ch of b.node.textBetween(a, z)) deleted.add(ch);
        view.dispatch(state.tr.delete(b.pos + 1 + a, b.pos + 1 + z));
      }
    } else if (op < 0.8 && paragraphs.length) {
      const b = pick(paragraphs);
      view.dispatch(state.tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, align: r() < 0.5 ? "center" : null }));
    } else if (op < 0.84 && who === 0 && editor.state.doc.childCount > 1) {
      // Move a block, as a drag does: delete it and insert the same node (same id) elsewhere.
      // Only one editor moves: two peers moving one block at once each re-create it, leaving
      // two copies with one id (Yjs has no move), a known limit this probe does not measure.
      const all = blocks(editor);
      const from = pick(all);
      const rest = all.filter((b) => b !== from);
      const to = pick(rest);
      moved.add(from.node.attrs.id);
      const tr = state.tr.delete(from.pos, from.pos + from.size);
      const at = tr.mapping.map(r() < 0.5 ? to.pos : to.pos + to.size);
      view.dispatch(tr.insert(at, from.node));
    } else if (op < 0.9 && paragraphs.length) {
      const b = pick(paragraphs);
      if (b.node.content.size > 1)
        view.dispatch(state.tr.addMark(b.pos + 1, b.pos + 1 + b.node.content.size, own.marks.strong!.create()));
    } else {
      deliverRandom();
    }
  }
  // An editor can answer a remote update with its own (a block id repair), so sync until quiet.
  while (outbox.some((row) => row.some((q) => q.length > 0))) {
    for (let i = 0; i < editorCount; i++) deliver(i, serverIndex);
    for (let i = 0; i < editorCount; i++) deliver(serverIndex, i);
  }

  const fragJson = (d: Y.Doc) => JSON.stringify(d.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toJSON());
  const diverged =
    docs.some((d) => fragJson(d) !== fragJson(docs[0]!)) ||
    peerEditors.some((e) => JSON.stringify(e.state.doc.toJSON()) !== JSON.stringify(peerEditors[0]!.state.doc.toJSON()));
  const present = peerEditors[0]!.state.doc.textContent;
  const byChar = owners(docs[0]!);
  let lost = 0;
  let duplicated = 0;
  let bylineMoved = 0;
  let misplaced = 0;
  for (const [c, who] of typedBy) {
    if (moved.has(typedIn.get(c))) continue;
    const count = present.split(c).length - 1;
    if (count === 0 && !deleted.has(c)) lost++;
    if (count > 1) duplicated++;
    if (count === 1 && byChar.get(c)?.client !== docs[who]!.clientID) bylineMoved++;
    if (count === 1 && byChar.get(c)?.block !== typedIn.get(c)) misplaced++;
  }
  const blockIds = docs[0]!.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toArray().map((b) => (b as Y.XmlElement).getAttribute("id"));
  const sharedIds = blockIds.length - new Set(blockIds).size;
  for (const e of peerEditors) e.destroy();
  vi.restoreAllMocks();
  return { lost, duplicated, bylineMoved, misplaced, sharedIds, rebuilt, diverged, typed: typedBy.size };
}

it(`fold fuzz: ${SEEDS} seeds x ${STEPS} steps`, () => {
  const total = { lost: 0, duplicated: 0, bylineMoved: 0, misplaced: 0, sharedIds: 0, rebuilt: 0, diverged: 0, typed: 0 };
  const failing: number[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const res = run(seed, 2 + (seed % 2));
    total.lost += res.lost;
    total.duplicated += res.duplicated;
    total.bylineMoved += res.bylineMoved;
    total.misplaced += res.misplaced;
    total.sharedIds += res.sharedIds;
    total.rebuilt += res.rebuilt;
    total.typed += res.typed;
    if (res.diverged) total.diverged++;
    if (res.lost || res.duplicated || res.bylineMoved || res.misplaced || res.sharedIds || res.rebuilt || res.diverged)
      failing.push(seed);
  }
  process.stdout.write(`${JSON.stringify({ seeds: SEEDS, steps: STEPS, ...total, failingSeeds: failing.slice(0, 20) })}\n`);
  expect(failing).toEqual([]);
}, 600_000);
