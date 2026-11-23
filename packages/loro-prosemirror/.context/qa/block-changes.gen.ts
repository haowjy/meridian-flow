// Seeded generator for the block-change fuzz (`block-changes-fuzz.md`): first documents on the real node
// types and random ProseMirror edits, ported from gate 5 (`gate/loro-fuzz`, tools/gate-fuzz/gen.mjs).
// Text is space-separated tokens `<origin><n>k` (s seed, l Live, f the writer, a the AI), so the oracle can
// follow every word; a mid-word edit writes `ZQ` into a token, which breaks it on purpose.
import { buildDocumentSchema } from "@meridian/prosemirror-schema";

export const schema = buildDocumentSchema();
export const COMMENT_POOL = 48;
export const commentMark = (id) => schema.marks.comment.create({ id });

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const TOKEN = /\b[a-z]\d+k\b/g;

export class Gen {
  constructor(seed) {
    this.rng = mulberry32(seed);
    this.n = 0;
    this.commentIds = [];
    this.used = new Set();
  }
  r() {
    return this.rng();
  }
  int(n) {
    return Math.floor(this.rng() * n);
  }
  pick(a) {
    return a[this.int(a.length)];
  }
  chance(p) {
    return this.rng() < p;
  }
  tok(origin) {
    return `${origin}${++this.n}k`;
  }
  words(origin, lo = 2, hi = 6) {
    return Array.from({ length: lo + this.int(hi - lo + 1) }, () => this.tok(origin)).join(" ");
  }
  newCommentId() {
    for (let i = 0; i < COMMENT_POOL; i++) {
      const id = `c${i}`;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
    return null;
  }

  // --- nodes ---
  para(origin, attrs = {}, extra = {}) {
    const content = [];
    content.push(schema.text(this.words(origin)));
    if (extra.image)
      content.push(
        schema.nodes.image.create({ src: `asset:img${this.n}`, alt: "a picture" }),
        schema.text(` ${this.words(origin, 1, 3)}`),
      );
    if (extra.hardBreak)
      content.push(schema.nodes.hard_break.create(), schema.text(this.words(origin, 1, 3)));
    return schema.nodes.paragraph.create(attrs, content);
  }
  nestingAttrs() {
    return this.pick([
      { kind: "bullet", marker: "-", path: "l0" },
      { kind: "ordered", marker: "1.", start: 1 + this.int(3), path: "l0" },
      { path: "q0" },
      { kind: "bullet", marker: "*", path: "q0/l0", loose: true },
    ]);
  }
  block(origin, kind = this.pick(KINDS)) {
    switch (kind) {
      case "paragraph":
        return this.para(origin);
      case "nested":
        return this.para(origin, this.nestingAttrs());
      case "heading":
        return this.para(origin, { level: 1 + this.int(6) });
      case "table": {
        const rows = 1 + this.int(2);
        const cols = 1 + this.int(2);
        const cell = (h) =>
          schema.nodes[h ? "table_header" : "table_cell"].create(null, [this.para(origin)]);
        return schema.nodes.table.create(
          null,
          Array.from({ length: rows }, (_, r) =>
            schema.nodes.table_row.create(
              null,
              Array.from({ length: cols }, () => cell(r === 0 && this.chance(0.3))),
            ),
          ),
        );
      }
      case "jsx":
        return schema.nodes.jsx_container.create(
          { name: "Aside", props: { tone: "quiet" } },
          Array.from({ length: 1 + this.int(2) }, () => this.para(origin)),
        );
      case "code":
        return schema.nodes.code_block.create(
          { language: this.pick([null, "js", "md"]) },
          schema.text(this.words(origin)),
        );
      case "image":
        return this.para(origin, {}, { image: true });
      case "hardbreak":
        return this.para(origin, {}, { hardBreak: true });
      case "hr":
        return schema.nodes.horizontal_rule.create();
      case "leaf":
        return schema.nodes.jsx_leaf.create(
          { name: "Callout", props: {} },
          schema.text(this.words(origin, 1, 3)),
        );
      case "figure":
        return schema.nodes.figure.create({ src: `asset:fig${this.n}`, caption: "cap" });
      default:
        throw new Error(kind);
    }
  }
  initialDoc() {
    const n = 4 + this.int(6);
    const blocks = [];
    // Every script has a few plain paragraphs; the rest is drawn from every kind.
    for (let i = 0; i < n; i++)
      blocks.push(this.block("s", i < 2 ? "paragraph" : this.pick(KINDS)));
    return schema.nodes.doc.create(null, blocks);
  }
}
const KINDS = [
  "paragraph",
  "paragraph",
  "nested",
  "heading",
  "table",
  "jsx",
  "code",
  "image",
  "hardbreak",
  "hr",
  "leaf",
  "figure",
];

// --- positions ---
/** Every textblock with its position, its top-level index, and its characters (inline leaves as \u0001). */
export function textblocks(doc) {
  const out = [];
  doc.forEach((top, offset, index) => {
    const visit = (node, pos) => {
      if (node.isTextblock) {
        const chars = [];
        node.forEach((child, off) => {
          if (child.isText)
            for (let i = 0; i < child.text.length; i++)
              chars.push([pos + 1 + off + i, child.text[i]]);
          else chars.push([pos + 1 + off, "\u0001"]);
        });
        out.push({ node, pos, top: index, end: pos + 1 + node.content.size, chars });
        return;
      }
      node.forEach((child, off) => {
        visit(child, pos + 1 + off);
      });
    };
    visit(top, offset);
  });
  return out;
}
export function wordsIn(tb) {
  const words = [];
  let cur = null;
  for (const [pos, ch] of tb.chars) {
    if (ch === " " || ch === "\u0001") {
      if (cur) words.push(cur);
      cur = null;
    } else if (cur && cur.to === pos) cur.to = pos + 1;
    else {
      if (cur) words.push(cur);
      cur = { from: pos, to: pos + 1 };
    }
  }
  if (cur) words.push(cur);
  return words;
}
function boundaries(tb) {
  const b = [tb.pos + 1];
  for (const [pos, ch] of tb.chars) if (ch === " " || ch === "\u0001") b.push(pos);
  b.push(tb.end);
  return [...new Set(b)];
}
const topPos = (doc, i) => {
  let p = 0;
  for (let k = 0; k < i; k++) p += doc.child(k).nodeSize;
  return p;
};
const allowsInline = (tb) => tb.node.type === schema.nodes.paragraph;
const allowsMarks = (tb) => tb.node.type.spec.marks !== "";

/**
 * One random edit as a transaction builder. `structure` allows block-level edits. Returns
 * { kind, build(tr, doc) => tr | null, comments?: [[id, body]] } or null.
 */
export function randomEdit(g, doc, origin, { structure = true, commentsHere = [], prefer = [] } = {}) {
  const tbs = textblocks(doc);
  // `prefer`: block ids to edit again most of the time (the dependent-press steps).
  const preferred = prefer.length ? tbs.filter((x) => prefer.includes(x.node.attrs.id)) : [];
  const tb = preferred.length && g.chance(0.8) ? g.pick(preferred) : tbs.length ? g.pick(tbs) : null;
  const words = tb ? wordsIn(tb) : [];
  const word = words.length ? g.pick(words) : null;
  const k = g.r();
  const kinds = [];
  // weights: text edits dominate, as in writing
  if (tb) kinds.push(["insert", 18], ["replace", 10]);
  if (word) kinds.push(["delete", 8], ["midword", 3]);
  if (word && allowsMarks(tb)) kinds.push(["mark", 6], ["unmark", 2], ["comment", 5]);
  if (commentsHere.length) kinds.push(["body", 3], ["uncomment", 2]);
  if (tb && allowsInline(tb)) kinds.push(["inline", 4]);
  if (structure) {
    kinds.push(["attrs", 5], ["insertBlock", 7], ["deleteBlock", 5]);
    if (tb && tb.top >= 0)
      kinds.push(
        ["split", 5],
        ["join", 4],
        ["setType", 2],
        ["move", 3],
        ["nestedBlock", 3],
        ["tableRow", 1],
      );
  }
  for (const off of (process.env.FUZZ_OFF ?? "").split(",").filter(Boolean))
    for (let i = kinds.length - 1; i >= 0; i--) if (kinds[i][0] === off) kinds.splice(i, 1);
  if (!kinds.length) return null;
  const total = kinds.reduce((s, [, w]) => s + w, 0);
  let x = k * total;
  let kind = kinds[kinds.length - 1][0];
  for (const [name, w] of kinds) {
    x -= w;
    if (x < 0) {
      kind = name;
      break;
    }
  }
  const t = () => g.tok(origin);
  switch (kind) {
    case "insert": {
      const b = g.pick(boundaries(tb));
      const text = b === tb.pos + 1 && tb.node.content.size ? `${t()} ` : ` ${t()}`;
      return { kind, build: (tr) => tr.insertText(text, b) };
    }
    case "replace": {
      if (!word) return { kind, build: (tr) => tr.insertText(t(), tb.pos + 1) };
      const last = g.chance(0.3)
        ? words[Math.min(words.length - 1, words.indexOf(word) + 1)]
        : word;
      const text = g.chance(0.5) ? t() : `${t()} ${t()}`;
      return { kind, build: (tr) => tr.insertText(text, word.from, last.to) };
    }
    case "delete": {
      const before = tb.chars.find(([p]) => p === word.from - 1);
      const after = tb.chars.find(([p]) => p === word.to);
      const from = before?.[1] === " " ? word.from - 1 : word.from;
      const to = from === word.from && after?.[1] === " " ? word.to + 1 : word.to;
      return { kind, build: (tr) => tr.delete(from, to) };
    }
    case "midword": {
      if (word.to - word.from < 3)
        return { kind, build: (tr) => tr.insertText("ZQ", word.from + 1, word.from + 1) };
      return { kind, build: (tr) => tr.insertText("ZQ", word.from + 1, word.from + 2) };
    }
    case "mark": {
      const type = g.pick(["strong", "em", "strike", "code", "link"]);
      const last = g.chance(0.4)
        ? words[Math.min(words.length - 1, words.indexOf(word) + 1)]
        : word;
      const mark =
        type === "link"
          ? schema.marks.link.create({ href: `https://example.com/${g.n}` })
          : schema.marks[type].create();
      return { kind, build: (tr) => tr.addMark(word.from, last.to, mark) };
    }
    case "unmark": {
      const type = g.pick(["strong", "em", "strike", "code", "link"]);
      return { kind, build: (tr) => tr.removeMark(tb.pos + 1, tb.end, schema.marks[type]) };
    }
    case "comment": {
      const id = g.newCommentId();
      if (!id) return null;
      const mark = commentMark(id);
      const body = {
        body: `note ${g.n}`,
        author: origin === "a" ? "agent" : "writer",
        resolved: false,
      };
      // a comment on two blocks, sometimes
      const other = g.chance(0.25)
        ? g.pick(tbs.filter((x) => x !== tb && allowsMarks(x) && wordsIn(x).length))
        : null;
      const ow = other ? g.pick(wordsIn(other)) : null;
      return {
        kind: other ? "comment2" : "comment",
        comments: [[id, body]],
        build: (tr) => {
          tr.addMark(word.from, word.to, mark);
          if (ow) tr.addMark(ow.from, ow.to, mark);
          return tr;
        },
      };
    }
    case "body": {
      const id = g.pick(commentsHere);
      return {
        kind,
        comments: [[id, { body: `edited ${g.n++}`, author: "writer", resolved: g.chance(0.3) }]],
        build: null,
      };
    }
    case "uncomment": {
      const id = g.pick(commentsHere);
      return { kind, build: (tr, d) => tr.removeMark(0, d.content.size, commentMark(id)) };
    }
    case "inline": {
      const b = g.pick(boundaries(tb));
      const node = g.chance(0.5)
        ? schema.nodes.hard_break.create()
        : schema.nodes.image.create({ src: `asset:img${g.n++}`, alt: "pic" });
      return { kind, build: (tr) => tr.insert(b, node) };
    }
    case "attrs": {
      const i = g.int(doc.childCount);
      const node = doc.child(i);
      const pos = topPos(doc, i);
      let attrs;
      if (node.type === schema.nodes.paragraph)
        attrs = g.chance(0.5)
          ? { level: g.pick([null, 1, 2, 3, 6]) }
          : g.chance(0.7)
            ? g.nestingAttrs()
            : { kind: null, marker: null, path: null, start: null, loose: null };
      else if (node.type === schema.nodes.code_block)
        attrs = { language: g.pick([null, "ts", "py"]) };
      else if (node.type === schema.nodes.table) attrs = { align: g.pick([null, "center"]) };
      else if (node.type === schema.nodes.jsx_container)
        attrs = { props: { tone: g.pick(["loud", "quiet", "plain"]) } };
      else if (node.type === schema.nodes.figure) attrs = { caption: `cap ${g.n++}` };
      else return null;
      return { kind, build: (tr) => tr.setNodeMarkup(pos, null, { ...node.attrs, ...attrs }) };
    }
    case "insertBlock": {
      const i = g.int(doc.childCount + 1);
      const node = g.block(origin);
      return { kind, build: (tr) => tr.insert(topPos(doc, i), node) };
    }
    case "deleteBlock": {
      if (doc.childCount < 2) return null;
      const i = g.int(doc.childCount);
      return { kind, build: (tr) => tr.delete(topPos(doc, i), topPos(doc, i + 1)) };
    }
    case "split": {
      if (tb.node.type !== schema.nodes.paragraph || words.length < 2) return null;
      const w = words[1 + g.int(words.length - 1)];
      return { kind, build: (tr) => tr.split(w.from - 1) };
    }
    case "join": {
      const i = tb.top;
      if (i + 1 >= doc.childCount) return null;
      const a = doc.child(i);
      const b = doc.child(i + 1);
      if (a.type !== b.type || !a.isTextblock) return null;
      return { kind, build: (tr) => tr.join(topPos(doc, i + 1)) };
    }
    case "setType": {
      const node = doc.child(tb.top);
      if (node !== tb.node) return null;
      const to =
        node.type === schema.nodes.code_block
          ? schema.nodes.paragraph
          : node.type === schema.nodes.paragraph
            ? schema.nodes.code_block
            : null;
      if (!to) return null;
      return { kind, build: (tr) => tr.setBlockType(tb.pos, tb.end, to, { id: node.attrs.id }) };
    }
    case "move": {
      if (doc.childCount < 3) return null;
      const from = g.int(doc.childCount);
      let to = g.int(doc.childCount);
      if (to === from) to = (from + 1) % doc.childCount;
      const node = doc.child(from);
      return {
        kind,
        build: (tr) => {
          tr.delete(topPos(doc, from), topPos(doc, from + 1));
          const rest = tr.doc;
          let p = 0;
          for (let k = 0; k < to && k < rest.childCount; k++) p += rest.child(k).nodeSize;
          return tr.insert(p, node);
        },
      };
    }
    case "nestedBlock": {
      // a paragraph inside a container (jsx_container or a table cell): add one, or delete one when it has siblings
      const containers = [];
      doc.descendants((node, pos) => {
        if (
          node.type === schema.nodes.jsx_container ||
          node.type === schema.nodes.table_cell ||
          node.type === schema.nodes.table_header
        )
          containers.push({ node, pos });
        return true;
      });
      if (!containers.length) return null;
      const c = g.pick(containers);
      if (c.node.childCount > 1 && g.chance(0.4)) {
        const j = g.int(c.node.childCount);
        let p = c.pos + 1;
        for (let k = 0; k < j; k++) p += c.node.child(k).nodeSize;
        return { kind: "nestedDelete", build: (tr) => tr.delete(p, p + c.node.child(j).nodeSize) };
      }
      return { kind, build: (tr) => tr.insert(c.pos + 1 + c.node.content.size, g.para(origin)) };
    }
    case "tableRow": {
      const tables = [];
      doc.forEach((node, offset) => {
        if (node.type === schema.nodes.table) tables.push({ node, pos: offset });
      });
      if (!tables.length) return null;
      const tbl = g.pick(tables);
      const cols = tbl.node.child(0).childCount;
      const row = schema.nodes.table_row.create(
        null,
        Array.from({ length: cols }, () => schema.nodes.table_cell.create(null, [g.para(origin)])),
      );
      return { kind, build: (tr) => tr.insert(tbl.pos + tbl.node.nodeSize - 1, row) };
    }
  }
  return null;
}
