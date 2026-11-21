// A 10k-word chapter in upstream loro-prosemirror 0.4.4's shape, and a keystroke-sized typist over it.

import { readFileSync } from "node:fs";
import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";
import { updateLoroToPmState } from "loro-prosemirror";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", attrs: { id: { default: null } } },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { id: { default: null }, level: { default: 2 } },
    },
    text: { group: "inline" },
  },
  marks: {
    bold: {},
    italic: {},
    link: { attrs: { href: {} }, inclusive: false },
    code: { inclusive: false },
    comment: { attrs: { id: {} }, excludes: "", inclusive: false },
  },
});

// The binding fork maps every `comment_<id>` style key to one `comment` mark (design §1); upstream 0.4.4 calls
// schema.mark(styleKey), so the read path goes through this view of the schema.
export const codecSchema = Object.create(schema, {
  mark: {
    value: (name, attrs) =>
      name.startsWith("comment_")
        ? schema.mark("comment", { id: name.slice(8) })
        : schema.mark(name, attrs),
  },
});

// Mark names keep the binding's one key per name; comments are one key per comment (`comment_<id>`, expand none,
// design §1), served by the default style so new comment keys need no reconfiguration.
export function configure(doc) {
  doc.configTextStyle({
    bold: { expand: "after" },
    italic: { expand: "after" },
    link: { expand: "none" },
    code: { expand: "none" },
  });
  doc.configDefaultTextStyle({ expand: "none" });
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = [
  "an",
  "el",
  "or",
  "ka",
  "mi",
  "to",
  "ri",
  "sa",
  "ven",
  "dor",
  "lin",
  "the",
  "ast",
  "ow",
  "un",
  "ir",
  "esh",
  "ra",
  "mo",
  "qu",
];
function word(r) {
  let w = "";
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) w += SYL[Math.floor(r() * SYL.length)];
  return w;
}
let idCounter = 0;
const blockId = (r) => `b${Math.floor(r() * 2 ** 32).toString(36)}${(idCounter++).toString(36)}`;

// 200 blocks of ~50 words (a heading every 15), bold/italic/link spans, 20 comments with bodies in LoroMap("comments").
export function buildChapter(seed, peer) {
  const r = rng(seed);
  const blocks = [];
  let words = 0;
  for (let i = 0; words < 10000; i++) {
    if (i % 15 === 0) {
      blocks.push(
        schema.node(
          "heading",
          { id: blockId(r), level: 2 },
          schema.text(`Part ${i / 15 + 1} ${word(r)}`),
        ),
      );
      continue;
    }
    const inl = [];
    for (let s = 0; s < 5; s++) {
      const ws = [];
      for (let k = 0; k < 10; k++) ws.push(word(r));
      words += 10;
      const txt = ws.join(" ") + (s < 4 ? ". " : ".");
      const m = r();
      const marks =
        m < 0.06
          ? [schema.marks.bold.create()]
          : m < 0.1
            ? [schema.marks.italic.create()]
            : m < 0.12
              ? [schema.marks.link.create({ href: `https://example.com/${word(r)}` })]
              : [];
      inl.push(schema.text(txt, marks));
    }
    blocks.push(schema.node("paragraph", { id: blockId(r) }, inl));
  }
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  configure(doc);
  updateLoroToPmState(
    doc,
    new Map(),
    EditorState.create({ schema, doc: schema.node("doc", null, blocks) }),
  );
  doc.commit();
  const children = doc.getMap("doc").get("children");
  for (let c = 0; c < 20; c++) {
    const b = children.get(1 + Math.floor(r() * (children.length - 1)));
    const t = b.get("children").get(0);
    const start = Math.floor(r() * Math.max(1, t.length - 40));
    addComment(doc, t, start, start + 10 + Math.floor(r() * 30), r);
  }
  doc.commit();
  return doc;
}

function addComment(doc, text, start, end, r) {
  const id = Math.floor(r() * 2 ** 40).toString(36);
  const body = doc.getMap("comments").setContainer(id, new LoroMap());
  body.set("body", `Comment ${word(r)} ${word(r)} ${word(r)}`);
  body.set("author", `u${Math.floor(r() * 5)}`);
  body.set("resolved", false);
  text.mark({ start, end: Math.min(end, text.length) }, `comment_${id}`, true);
}

// One keystroke-sized edit, committed. Cursor state lives in `cur` ({ block, offset }).
export function keystroke(doc, cur, r) {
  const children = doc.getMap("doc").get("children");
  if (cur.block >= children.length) cur.block = children.length - 1;
  const node = children.get(cur.block);
  let text = node.get("children").get(0);
  if (cur.offset > text.length) cur.offset = text.length;
  const x = r();
  let kind;
  if (x < 0.8) {
    const ch = r() < 0.18 ? " " : String.fromCharCode(97 + Math.floor(r() * 26));
    text.insert(cur.offset, ch);
    cur.offset++;
    kind = "char";
  } else if (x < 0.9) {
    if (cur.offset > 0) {
      text.delete(cur.offset - 1, 1);
      cur.offset--;
    }
    kind = "backspace";
  } else if (x < 0.93) {
    const n = Math.min(cur.offset, 1 + Math.floor(r() * 6));
    if (n) {
      text.delete(cur.offset - n, n);
      cur.offset -= n;
    }
    kind = "delword";
  } else if (x < 0.95) {
    cur.block = 1 + Math.floor(r() * (children.length - 1));
    text = children.get(cur.block).get("children").get(0);
    cur.offset = Math.floor(r() * (text.length + 1));
    kind = "move";
    return kind;
  } else if (x < 0.965) {
    const s = Math.max(0, cur.offset - 6);
    if (cur.offset > s) text.mark({ start: s, end: cur.offset }, "bold", true);
    kind = "bold";
  } else if (x < 0.975) {
    const s = Math.max(0, cur.offset - 6);
    if (cur.offset > s) text.mark({ start: s, end: cur.offset }, "italic", true);
    kind = "italic";
  } else if (x < 0.985) {
    // Enter: split the block at the cursor into a new paragraph.
    const tail = text.slice(cur.offset, text.length);
    if (tail.length) text.delete(cur.offset, tail.length);
    const fresh = children.insertContainer(cur.block + 1, new LoroMap());
    fresh.set("nodeName", "paragraph");
    fresh.setContainer("attributes", new LoroMap()).set("id", blockId(r));
    const t = fresh.setContainer("children", new LoroList()).insertContainer(0, new LoroText());
    if (tail.length) t.insert(0, tail);
    cur.block++;
    cur.offset = 0;
    kind = "enter";
  } else if (x < 0.988) {
    const s = Math.max(0, cur.offset - 8);
    if (cur.offset > s) addComment(doc, text, s, cur.offset, r);
    kind = "comment";
  } else if (x < 0.99) {
    const s = Math.max(0, cur.offset - 5);
    if (cur.offset > s)
      text.mark({ start: s, end: cur.offset }, "link", { href: "https://example.com/x" });
    kind = "link";
  } else {
    const s = Math.max(0, cur.offset - 10);
    if (cur.offset > s) text.unmark({ start: s, end: cur.offset }, "bold");
    kind = "unbold";
  }
  doc.commit();
  return kind;
}

export function wasmMemoryBytes() {
  return globalThis.__loroWasmMemory?.buffer.byteLength ?? NaN;
}

export async function hookWasmMemory() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const path = await import("node:path");
  const wasm = require(
    path.join(path.dirname(require.resolve("loro-crdt")), "loro_wasm.js"),
  ).__wasm;
  globalThis.__loroWasmMemory = wasm.memory;
}

export function mem() {
  const m = process.memoryUsage();
  const mb = (b) => Math.round((b / 1048576) * 10) / 10;
  // Under host memory pressure the kernel swaps the process out and RSS drops: report swap beside it.
  const swap =
    Number(/VmSwap:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? 0) * 1024;
  return {
    rss: mb(m.rss),
    swap: mb(swap),
    heapUsed: mb(m.heapUsed),
    heapTotal: mb(m.heapTotal),
    external: mb(m.external),
    arrayBuffers: mb(m.arrayBuffers),
    wasm: mb(wasmMemoryBytes()),
  };
}
