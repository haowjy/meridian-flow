import {
  configLoroTextStyle,
  createNodeFromLoroObj,
  heldUpdateCount,
  importRemoteUpdate,
  type LoroDocType,
  LoroSyncPlugin,
  LoroUndoPlugin,
  loroSyncPluginKey,
  ROOT_DOC_KEY,
  redo,
  undo,
  updateLoroToPmState,
} from "@meridian/loro-prosemirror";
import { newBlockId, withBlockIds } from "@meridian/prosemirror-schema";
import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { fixBlockIds } from "./fix-block-ids";
import { buildEditorSchema } from "./schema";
import { selfChecks } from "./self-checks";

const schema = buildEditorSchema();
type PeerName = "A" | "B" | "AI";

// ─── content ────────────────────────────────────────────────────────

const WORDS =
  "the rain had not stopped since morning and she counted the steps down to the river where the boats waited for a word that never came from the city beyond the hills".split(
    " ",
  );

/** A chapter of about `words` words in 50-word paragraphs, with a heading, marks, a comment and a hard break. */
function chapter(words: number): PMNode {
  const blocks: PMNode[] = [
    schema.nodes.paragraph.create({ level: 1 }, schema.text("Chapter One")),
  ];
  const paragraphs = Math.max(1, Math.round(words / 50));
  let w = 0;
  for (let p = 0; p < paragraphs; p++) {
    const parts: string[] = [];
    for (let i = 0; i < 50; i++) parts.push(WORDS[w++ % WORDS.length]);
    const text = parts.join(" ") + ".";
    const inline: PMNode[] = [];
    if (p % 7 === 3) {
      const cut = text.indexOf(" ", 40);
      inline.push(schema.text(text.slice(0, cut)));
      inline.push(schema.text(text.slice(cut, cut + 20), [schema.marks.strong.create()]));
      inline.push(schema.text(text.slice(cut + 20)));
    } else if (p % 11 === 5) {
      const cut = text.indexOf(" ", 60);
      inline.push(schema.text(text.slice(0, cut)));
      inline.push(
        schema.text(text.slice(cut, cut + 25), [schema.marks.comment.create({ id: `c${p}` })]),
      );
      inline.push(schema.nodes.hard_break.create());
      inline.push(schema.text(text.slice(cut + 25)));
    } else {
      inline.push(schema.text(text));
    }
    blocks.push(schema.nodes.paragraph.create(null, inline));
  }
  return withBlockIds(schema.nodes.doc.create(null, blocks));
}

function shortChapter(): PMNode {
  const p = (t: string) => schema.nodes.paragraph.create(null, schema.text(t));
  return withBlockIds(
    schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create({ level: 1 }, schema.text("Gate page")),
      p("The first paragraph is plain text for typing and composing."),
      p("The second paragraph is where a remote peer types."),
      p("The third paragraph closes the page."),
    ]),
  );
}

// ─── peers and the relay ────────────────────────────────────────────

/** `dispatchMs`: the transaction's apply and view update (the Loro write included). `sinceKeyMs`: from the keydown that caused it to the end of that update (the browser's DOM edit, ProseMirror reading it, the dispatch). */
type Timing = {
  at: number;
  dispatchMs: number;
  sinceKeyMs: number | null;
  key: string | null;
  steps: number;
};
type RemoteApply = {
  at: number;
  composing: boolean;
  dispatchMs: number;
  blocksAdded: number;
  blocksRemoved: number;
  caretBlockReplaced: boolean;
  caretTextNodeReplaced: boolean;
  caretBefore: SelectionReport;
  caretAfter: SelectionReport;
};
type SelectionReport = {
  anchor: number;
  head: number;
  blockId: string | null;
  offset: number;
  around: string;
};

type Peer = {
  name: PeerName;
  doc: LoroDoc;
  view: EditorView | null;
  online: boolean;
  timings: Timing[];
  remoteApplies: RemoteApply[];
  /** Wall time of each remote import that was applied at once: Loro import, event, editor rebuild and dispatch. */
  importMs: number[];
  unsubscribe: () => void;
};

const log: { at: number; peer: PeerName; event: string; detail?: unknown }[] = [];
const note = (peer: PeerName, event: string, detail?: unknown) =>
  log.push({ at: Math.round(performance.now() * 10) / 10, peer, event, detail });

let peers: Record<PeerName, Peer>;
let latencyMs = 0;
/** Off: remote updates import at once, as upstream does (the control for the composition guard). */
let useHold = true;
let peerSeq = 1n;

function send(from: Peer, bytes: Uint8Array) {
  if (!from.online) return; // the reconnect exchange carries it
  for (const to of Object.values(peers)) {
    if (to === from || !to.online) continue;
    const deliver = () => {
      if (!to.online || !from.online) return;
      const t0 = performance.now();
      const status = useHold ? importRemoteUpdate(to.doc, bytes) : to.doc.import(bytes);
      if (status !== null) to.importMs.push(performance.now() - t0);
      if (status === null)
        note(to.name, "remote-held", { from: from.name, held: heldUpdateCount(to.doc) });
      else note(to.name, "remote-imported", { from: from.name, bytes: bytes.length });
    };
    if (latencyMs > 0) setTimeout(deliver, latencyMs);
    else queueMicrotask(deliver);
  }
}

/** Version-vector exchange on reconnect, both ways (what the design's Join does). */
function reconnect(peer: Peer) {
  for (const other of Object.values(peers)) {
    if (other === peer || !other.online) continue;
    const toPeer = other.doc.export({ mode: "update", from: peer.doc.oplogVersion() });
    const toOther = peer.doc.export({ mode: "update", from: other.doc.oplogVersion() });
    importRemoteUpdate(peer.doc, toPeer);
    importRemoteUpdate(other.doc, toOther);
    note(peer.name, "reconnect-exchange", {
      with: other.name,
      received: toPeer.length,
      sent: toOther.length,
    });
  }
}

function makeDoc(snapshot?: Uint8Array): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(peerSeq++);
  configLoroTextStyle(doc, schema);
  if (snapshot) doc.import(snapshot);
  return doc;
}

const blockIdPlugin = new Plugin({
  filterTransaction: (tr, state) => {
    fixBlockIds(tr, state);
    return true;
  },
});

function mount(peer: Peer, host: HTMLElement, binding = true) {
  const el = document.createElement("div");
  el.className = "editor";
  el.dataset.peer = peer.name;
  host.append(el);
  const observer = new MutationObserver(() => {});
  let view: EditorView;
  view = new EditorView(el, {
    state: EditorState.create({
      schema,
      ...(binding
        ? {
            plugins: [
              blockIdPlugin,
              LoroSyncPlugin({ doc: peer.doc as LoroDocType }),
              LoroUndoPlugin({ doc: peer.doc }),
              keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
              keymap(baseKeymap),
            ],
          }
        : {
            // The baseline: the same document and DOM with no binding.
            doc: createNodeFromLoroObj(
              schema,
              (peer.doc as LoroDocType).getMap(ROOT_DOC_KEY),
              new Map(),
            ),
            plugins: [blockIdPlugin, keymap(baseKeymap)],
          }),
    }),
    dispatchTransaction(tr: Transaction) {
      const meta = tr.getMeta(loroSyncPluginKey) as { type?: string } | undefined;
      const remote = meta?.type === "non-local-updates";
      const caretBefore = remote ? selectionReport(view) : null;
      if (remote) observer.takeRecords();
      const t0 = performance.now();
      view.updateState(view.state.apply(tr));
      const dispatchMs = performance.now() - t0;
      if (tr.docChanged && !meta) {
        const end = performance.now();
        peer.timings.push({
          at: t0,
          dispatchMs,
          sinceKeyMs: lastKey ? end - lastKey.at : null,
          key: lastKey?.key ?? null,
          steps: tr.steps.length,
        });
        lastKey = null;
      }
      if (remote && caretBefore) {
        const records = observer.takeRecords();
        peer.remoteApplies.push({
          at: t0,
          composing: view.composing,
          dispatchMs,
          ...churn(view, records, caretBefore),
          caretBefore,
          caretAfter: selectionReport(view),
        });
        note(peer.name, "remote-applied", {
          composing: view.composing,
          dispatchMs: Math.round(dispatchMs * 100) / 100,
        });
      }
    },
  });
  observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
  let lastKey: { at: number; key: string } | null = null;
  view.dom.addEventListener(
    "keydown",
    (e) => {
      lastKey = { at: performance.now(), key: e.key };
    },
    { capture: true },
  );
  for (const type of ["compositionstart", "compositionupdate", "compositionend"] as const) {
    view.dom.addEventListener(type, (e) =>
      note(peer.name, type, {
        data: (e as CompositionEvent).data,
        held: heldUpdateCount(peer.doc),
      }),
    );
  }
  view.dom.addEventListener("beforeinput", (e) =>
    note(peer.name, "beforeinput", {
      inputType: (e as InputEvent).inputType,
      data: (e as InputEvent).data,
    }),
  );
  peer.view = view;
}

/** What a remote application did to the DOM: blocks added or removed, and whether the caret's block or text node was replaced. */
function churn(view: EditorView, records: MutationRecord[], caretBefore: SelectionReport) {
  let blocksAdded = 0;
  let blocksRemoved = 0;
  for (const r of records) {
    if (r.type !== "childList" || r.target !== view.dom) continue;
    blocksAdded += r.addedNodes.length;
    blocksRemoved += r.removedNodes.length;
  }
  const caretEl = caretBefore.blockId
    ? view.dom.querySelector(`[data-block-id="${caretBefore.blockId}"]`)
    : null;
  let caretBlockReplaced = false;
  let caretTextNodeReplaced = false;
  for (const r of records) {
    if (r.type !== "childList") continue;
    for (const n of r.removedNodes) {
      if (n instanceof HTMLElement && n.dataset.blockId === caretBefore.blockId)
        caretBlockReplaced = true;
    }
    if (caretEl && (r.target === caretEl || caretEl.contains(r.target)))
      caretTextNodeReplaced = true;
  }
  return { blocksAdded, blocksRemoved, caretBlockReplaced, caretTextNodeReplaced };
}

function selectionReport(view: EditorView): SelectionReport {
  const { anchor, head } = view.state.selection;
  const $head = view.state.doc.resolve(head);
  const block = $head.parent;
  const text = block.textContent;
  const offset = $head.parentOffset;
  return {
    anchor,
    head,
    blockId: (block.attrs.id as string | null) ?? null,
    offset,
    around: `${text.slice(Math.max(0, offset - 12), offset)}|${text.slice(offset, offset + 12)}`,
  };
}

function reset(content: PMNode, binding = true) {
  if (peers) {
    for (const p of Object.values(peers)) {
      p.unsubscribe();
      p.view?.destroy();
    }
  }
  const host = document.getElementById("editors")!;
  host.replaceChildren();
  log.length = 0;
  const seed = makeDoc();
  updateLoroToPmState(seed as LoroDocType, new Map(), EditorState.create({ schema, doc: content }));
  const snapshot = seed.export({ mode: "snapshot" });
  const make = (name: PeerName): Peer => ({
    name,
    doc: makeDoc(snapshot),
    view: null,
    online: true,
    timings: [],
    remoteApplies: [],
    importMs: [],
    unsubscribe: () => {},
  });
  peers = { A: make("A"), B: make("B"), AI: make("AI") };
  for (const p of Object.values(peers))
    p.unsubscribe = p.doc.subscribeLocalUpdates((u) => send(p, u));
  mount(peers.A, host, binding);
  mount(peers.B, host);
  return new Promise<void>((r) => setTimeout(r, 10));
}

// ─── hooks ──────────────────────────────────────────────────────────

function viewOf(name: PeerName): EditorView {
  const v = peers[name].view;
  if (!v) throw new Error(`peer ${name} has no editor`);
  return v;
}

function blockPos(view: EditorView, id: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs.id === id) found = { pos, node };
    return !node.isTextblock;
  });
  return found;
}

function nthTextblock(view: EditorView, n: number): { pos: number; node: PMNode } {
  let i = 0;
  let found: { pos: number; node: PMNode } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock) {
      if (i++ === n) found = { pos, node };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`no textblock ${n}`);
  return found;
}

/** Where a remote write lands, relative to peer A's caret block. */
type Where =
  | "before-caret"
  | "after-caret"
  | "block-start"
  | "block-end"
  | { block: number; offset: number }
  | { caretBlockOffset: number };

function remoteTarget(view: EditorView, where: Where): number {
  const a = selectionReport(viewOf("A"));
  if (typeof where === "object" && "block" in where) {
    const { pos, node } = nthTextblock(view, where.block);
    return pos + 1 + Math.min(where.offset, node.content.size);
  }
  const target = a.blockId ? blockPos(view, a.blockId) : null;
  if (!target) throw new Error("A's caret block is not in the peer's document");
  const size = target.node.content.size;
  const offset =
    typeof where === "object"
      ? Math.min(size, where.caretBlockOffset)
      : where === "before-caret"
        ? Math.max(0, a.offset - 1)
        : where === "after-caret"
          ? Math.min(size, a.offset + 1)
          : where === "block-start"
            ? 0
            : size;
  return target.pos + 1 + offset;
}

function aiDocBlock(doc: LoroDoc, id: string): { index: number; map: LoroMap } | null {
  const children = doc.getMap(ROOT_DOC_KEY).get("children") as LoroList;
  for (let i = 0; i < children.length; i++) {
    const c = children.get(i);
    if (c instanceof LoroMap && (c.get("attributes") as LoroMap | undefined)?.get("id") === id)
      return { index: i, map: c };
  }
  return null;
}

function insertAiParagraph(children: LoroList, index: number, text: string) {
  const m = children.insertContainer(index, new LoroMap());
  m.set("nodeName", "paragraph");
  const attrs = m.setContainer("attributes", new LoroMap());
  attrs.set("id", newBlockId());
  const kids = m.setContainer("children", new LoroList());
  const t = kids.insertContainer(0, new LoroText());
  t.insert(0, text);
}

function aiText(bytes: number): string[] {
  const paras: string[] = [];
  let total = 0;
  let w = 7;
  while (total < bytes) {
    const parts: string[] = [];
    for (let i = 0; i < 90 && total + parts.join(" ").length < bytes; i++)
      parts.push(WORDS[w++ % WORDS.length]);
    const t = `${parts.join(" ")}.`;
    paras.push(t);
    total += t.length;
  }
  return paras;
}

function sameDocs(a: LoroDoc, b: LoroDoc) {
  return (
    JSON.stringify(a.getMap(ROOT_DOC_KEY).toJSON()) ===
    JSON.stringify(b.getMap(ROOT_DOC_KEY).toJSON())
  );
}

function percentile(xs: number[], p: number) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 1000) / 1000;
}

const eventTimings: { name: string; duration: number; processing: number; at: number }[] = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries() as PerformanceEventTiming[]) {
    eventTimings.push({
      name: e.name,
      duration: e.duration,
      processing: e.processingEnd - e.processingStart,
      at: e.startTime,
    });
  }
}).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);

const gate = {
  /** Reset to the short page (4 blocks). */
  loadShort: () => reset(shortChapter()),
  /** Reset with a chapter of about `words` words (10k by default: 201 blocks). */
  loadChapter: (words = 10_000) => reset(chapter(words)),
  /** The same chapter with peer A on plain ProseMirror (no binding): the baseline for keystroke timings. */
  loadPlain: (words = 10_000) => reset(chapter(words), false),

  /** Put peer A's caret in textblock `block` at `offset` (or the block's end) and focus it. */
  placeCaret(block: number, offset?: number, peer: PeerName = "A") {
    const view = viewOf(peer);
    const { pos, node } = nthTextblock(view, block);
    const at = pos + 1 + Math.min(offset ?? node.content.size, node.content.size);
    view.focus();
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).scrollIntoView(),
    );
    return selectionReport(view);
  },

  /** Peer B types `text` into its own editor at `where` (relative to A's caret block); it reaches A through the relay. */
  remoteKeystroke(text = "x", where: Where = "before-caret") {
    const view = viewOf("B");
    const at = remoteTarget(view, where);
    view.dispatch(view.state.tr.insertText(text, at));
    note("B", "remote-keystroke", { text, at });
    return at;
  },

  /**
   * The AI peer writes about `bytes` bytes as one Loro commit and sends it as one update.
   * `mode`: "insert-blocks" adds paragraphs after A's caret block; "same-block" appends the text
   * to A's caret block (past the caret); "replace-next" rewrites the block after A's caret block.
   */
  aiWrite(bytes = 2048, mode: "insert-blocks" | "same-block" | "replace-next" = "insert-blocks") {
    const doc = peers.AI.doc;
    const a = selectionReport(viewOf("A"));
    if (!a.blockId) throw new Error("A's caret is in a block without id");
    const block = aiDocBlock(doc, a.blockId);
    if (!block) throw new Error("A's caret block is not in the AI peer's document");
    const children = doc.getMap(ROOT_DOC_KEY).get("children") as LoroList;
    const paras = aiText(bytes);
    if (mode === "insert-blocks") {
      paras.forEach((t, i) => {
        insertAiParagraph(children, block.index + 1 + i, t);
      });
    } else if (mode === "same-block") {
      const text = (block.map.get("children") as LoroList).get(0) as LoroText;
      text.insert(text.length, ` ${paras.join(" ")}`);
    } else {
      const next = children.get(block.index + 1) as LoroMap;
      const text = (next.get("children") as LoroList).get(0) as LoroText;
      text.delete(0, text.length);
      text.insert(0, paras.join(" "));
    }
    doc.commit({ origin: "agent:gate" });
    note("AI", "ai-write", { bytes, mode, paragraphs: paras.length });
    return { paragraphs: paras.length, chars: paras.join("").length };
  },

  offline(peer: PeerName = "A") {
    peers[peer].online = false;
    note(peer, "offline");
  },
  /** Reconnect: version-vector exchange both ways, imported at once. Returns its wall time in ms. */
  online(peer: PeerName = "A") {
    const t0 = performance.now();
    peers[peer].online = true;
    reconnect(peers[peer]);
    const ms = performance.now() - t0;
    note(peer, "online", { ms });
    return ms;
  },
  setLatency(ms: number) {
    latencyMs = ms;
  },
  /** Turn the composition guard off (remote updates import at once) or back on. */
  useHold(on: boolean) {
    useHold = on;
  },

  /** Peer state: text, selection, whether the editor matches its Loro document, held updates. */
  state(peer: PeerName = "A") {
    const p = peers[peer];
    const view = p.view;
    const fromLoro = createNodeFromLoroObj(
      schema,
      (p.doc as LoroDocType).getMap(ROOT_DOC_KEY),
      new Map(),
    );
    return {
      text: view
        ? view.state.doc.textBetween(0, view.state.doc.content.size, "\n")
        : fromLoro.textBetween(0, fromLoro.content.size, "\n"),
      blocks: (view?.state.doc ?? fromLoro).childCount,
      selection: view ? selectionReport(view) : null,
      composing: view?.composing ?? false,
      held: heldUpdateCount(p.doc),
      editorMatchesLoro: view ? view.state.doc.eq(fromLoro) : null,
      online: p.online,
    };
  },

  /** Whether every peer's Loro document is the same, and each editor shows its document. */
  converged() {
    const docs = Object.values(peers).map((p) => p.doc);
    const loroEqual = docs.every((d) => sameDocs(d, docs[0]));
    const a = gate.state("A");
    const b = gate.state("B");
    return {
      loroEqual,
      editorsMatchLoro: a.editorMatchesLoro && b.editorMatchesLoro,
      textEqual: a.text === b.text,
    };
  },

  /** Per-keystroke timings for a peer since the last reset or `clearTimings`. */
  timings(peer: PeerName = "A") {
    const all = peers[peer].timings;
    const ms = all.map((t) => t.dispatchMs);
    const stats = (xs: number[]) => ({
      n: xs.length,
      median: percentile(xs, 50),
      p95: percentile(xs, 95),
      max: percentile(xs, 100),
    });
    const sinceKey = (pred: (t: Timing) => boolean) =>
      stats(all.filter((t) => t.sinceKeyMs != null && pred(t)).map((t) => t.sinceKeyMs as number));
    const ev = eventTimings.filter((e) =>
      ["keydown", "keypress", "beforeinput", "input", "keyup"].includes(e.name),
    );
    return {
      keystrokes: ms.length,
      dispatchMs: stats(ms),
      keydownToUpdatedMs: {
        all: sinceKey(() => true),
        chars: sinceKey((t) => t.key != null && t.key.length === 1),
        enter: sinceKey((t) => t.key === "Enter"),
        backspace: sinceKey((t) => t.key === "Backspace"),
      },
      // Event Timing entries over 16 ms (input to next paint, 8 ms granularity).
      slowEvents: ev.length,
      slowEventDurations: ev.map((e) => e.duration),
      raw: ms,
    };
  },
  /** Remote import cost on a peer (import, event, rebuild, dispatch), since the last reset or `clearTimings`. */
  importTimings(peer: PeerName = "B") {
    const xs = peers[peer].importMs;
    return {
      n: xs.length,
      median: percentile(xs, 50),
      p95: percentile(xs, 95),
      max: percentile(xs, 100),
    };
  },
  clearTimings() {
    for (const p of Object.values(peers)) {
      p.timings.length = 0;
      p.importMs.length = 0;
    }
    eventTimings.length = 0;
  },
  remoteApplies: (peer: PeerName = "A") => peers[peer].remoteApplies,
  log: () => log,
  clearLog: () => {
    log.length = 0;
  },
  held: (peer: PeerName = "A") => heldUpdateCount(peers[peer].doc),
  /** Binding-level checks of the fork's changes (#77, block-id pairing, comment keys, #88, commit origin). */
  selfChecks: () => selfChecks(schema),
  peers: () => peers,
};

declare global {
  interface Window {
    gate: typeof gate & { ready: Promise<void> };
  }
}
window.gate = Object.assign(gate, { ready: gate.loadShort() });
