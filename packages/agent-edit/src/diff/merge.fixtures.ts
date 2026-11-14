/**
 * Fixtures for the merge's tests: a tiny document notation, seeded random documents with concurrent edit
 * scripts and ground truth, an invariant oracle that follows each unique word through a merge, and the
 * spec's fixed case table (spec-content-rebase.md section 5). Words are unique ("w17") so a word's text
 * is its identity.
 */
import { hasBlockId, withBlockIds } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { correspond } from "./correspond.js";
import type { Conflict } from "./merge.js";
import type { Tok } from "./tokens.js";

/** `text#id` is a unit with the id `id`; no suffix, no id. */
const withId = (text: string): [string, { id: string } | null] => {
  const m = /^(.*)#(\w+)$/s.exec(text);
  return m ? [m[1], { id: m[2] }] : [text, null];
};

/**
 * A document in the case table's notation: blocks joined by ` | `, each `kind:text`. A block's id is
 * written after its kind (`p#a:text`); a list item's, a quote paragraph's and a table cell's after
 * its text (`list:one#a;two#b`). Blocks with no id are given one by `tagBySide`.
 */
export function parseDoc(schema: Schema, src: string): PMNode[] {
  return src.split(" | ").flatMap((part) => {
    const i = part.indexOf(":");
    const head = i < 0 ? part.trim() : part.slice(0, i).trim();
    const text = i < 0 ? "" : part.slice(i + 1);
    // `p#a{path=--,marker=done}:text` sets the id and block attributes.
    const [, bare, braces] = /^(.*?)(?:\{([^}]*)\})?$/s.exec(head) ?? [];
    const attrs = Object.fromEntries(
      (braces?.split(",") ?? []).filter(Boolean).map((kv) => kv.split("=") as [string, string]),
    );
    const [kind, own] = bare.includes("#")
      ? [bare.slice(0, bare.indexOf("#")), { id: bare.slice(bare.indexOf("#") + 1), ...attrs }]
      : [bare, braces ? attrs : null];
    const para = (t: string, extra?: object) => {
      const [body, id] = withId(t);
      return schema.nodes.paragraph.create({ ...id, ...extra }, inline(schema, body));
    };
    if (kind === "hr") return schema.nodes.horizontal_rule.create(own);
    if (kind === "fig")
      return schema.nodes.figure.create({ src: `asset:${text}`, alt: text, ...own });
    if (kind === "quote") return text.split(";").map((t) => para(t, { path: ">" }));
    if (kind === "table")
      return schema.nodes.table.create(
        own,
        text.split(";").map((row) =>
          schema.nodes.table_row.create(
            null,
            row.split(",").map((cell) => {
              // `alpha^2` is a cell spanning two columns.
              const [, body, span] = /^(.*?)(?:\^(\d+))?$/.exec(cell) ?? [];
              return schema.nodes.table_cell.create({ colspan: Number(span ?? 1) }, para(body));
            }),
          ),
        ),
      );
    if (kind === "list") return text.split(";").map((t) => para(t, { path: "-", marker: "item" }));
    if (kind.startsWith("h"))
      return schema.nodes.paragraph.create(
        { level: Number(kind.slice(1)) || 1, ...own },
        inline(schema, text),
      );
    if (kind === "p") return schema.nodes.paragraph.create(own, inline(schema, text));
    if (kind === "pc")
      return schema.nodes.paragraph.create({ align: "center", ...own }, inline(schema, text));
    throw new Error(`bad block ${part}`);
  });
}

/**
 * Ids for a case's three documents, as an editor would have left them. Base blocks with no id get
 * one; a side's block with none takes the id of the base block it is by guess (what the model's
 * write does), or a new id.
 */
export function tagBySide(
  base: readonly PMNode[],
  live: readonly PMNode[],
  draft: readonly PMNode[],
): [PMNode[], PMNode[], PMNode[]] {
  let n = 0;
  const fresh = (node: PMNode): PMNode =>
    withBlockIds(node.type.create(node.attrs, fillIds(node), node.marks));
  const fillIds = (node: PMNode): PMNode[] => {
    const kids: PMNode[] = [];
    node.forEach((c) => {
      kids.push(c.isText ? c : fresh(c));
    });
    return kids;
  };
  const tagBase = (nodes: readonly PMNode[]): PMNode[] =>
    nodes.map((node) => {
      if (node.isText) return node;
      const kids: PMNode[] = [];
      node.forEach((c) => {
        kids.push(...tagBase([c]));
      });
      const id = hasBlockId(node) ? (node.attrs.id ?? `b${++n}`) : undefined;
      return node.type.create(
        id === undefined ? node.attrs : { ...node.attrs, id },
        kids,
        node.marks,
      );
    });
  const tagSide = (old: readonly PMNode[], nodes: readonly PMNode[]): PMNode[] => {
    const c = correspond(old, nodes);
    return nodes.map((node, j) => {
      if (node.isText) return node;
      const i = c.back[j];
      const partner = i >= 0 && c.partner[i] === j && old[i].type === node.type ? old[i] : null;
      const kids: PMNode[] = [];
      if (partner && !node.isTextblock) {
        const inner = tagSide(
          Array.from({ length: partner.childCount }, (_, k) => partner.child(k)),
          Array.from({ length: node.childCount }, (_, k) => node.child(k)),
        );
        kids.push(...inner);
      } else if (!node.isTextblock) kids.push(...fillIds(node));
      else for (let k = 0; k < node.childCount; k++) kids.push(node.child(k));
      const own = hasBlockId(node) ? (node.attrs.id ?? partner?.attrs.id ?? `n${++n}`) : undefined;
      return node.type.create(
        own === undefined ? node.attrs : { ...node.attrs, id: own },
        kids,
        node.marks,
      );
    });
  };
  const tb = tagBase(base);
  return [tb, tagSide(tb, live), tagSide(tb, draft)];
}

function inline(schema: Schema, text: string): PMNode[] {
  const out: PMNode[] = [];
  for (const m of text.matchAll(/\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)|([^*[]+)/g)) {
    if (m[1]) out.push(schema.text(m[1], [schema.marks.strong.create()]));
    else if (m[2]) out.push(schema.text(m[2], [schema.marks.em.create()]));
    else if (m[3]) out.push(schema.text(m[3], [schema.marks.link.create({ href: m[4] })]));
    else if (m[5]) out.push(schema.text(m[5]));
  }
  return out;
}

export function render(blocks: readonly PMNode[]): string {
  const parts: string[] = [];
  let kind: string | null = null;
  let texts: string[] = [];
  for (const b of blocks) {
    const k =
      b.type.name !== "paragraph"
        ? null
        : b.attrs.path === "-" && b.attrs.marker === "item"
          ? "list"
          : b.attrs.path === ">"
            ? "quote"
            : null;
    if (k) {
      if (k !== kind) {
        texts = [];
        parts.push("");
      }
      kind = k;
      texts.push(b.textContent);
      parts[parts.length - 1] = `${k}:${texts.join(";")}`;
      continue;
    }
    kind = null;
    parts.push(renderBlock(b));
  }
  return parts.join(" | ");
}

function renderBlock(b: PMNode): string {
  if (b.type.name === "horizontal_rule") return "hr";
  if (b.type.name === "figure") return `fig:${b.attrs.alt}`;
  if (b.type.name === "table") {
    const rows: string[] = [];
    b.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => {
        cells.push(cell.textContent + (cell.attrs.colspan > 1 ? `^${cell.attrs.colspan}` : ""));
      });
      rows.push(cells.join(","));
    });
    return `table:${rows.join(";")}`;
  }
  let t = "";
  b.forEach((n) => {
    const em = n.marks.some((m) => m.type.name === "em");
    const st = n.marks.some((m) => m.type.name === "strong");
    const link = n.marks.find((m) => m.type.name === "link");
    let s = n.text ?? "";
    if (link) s = `[${s}](${link.attrs.href})`;
    t += st && em ? `***${s}***` : st ? `**${s}**` : em ? `*${s}*` : s;
  });
  const kind =
    b.attrs.level !== null && b.type.name === "paragraph"
      ? `h${b.attrs.level}`
      : b.attrs.align === "center"
        ? "pc"
        : "p";
  const nesting = ["path", "marker"].filter((key) => b.attrs[key] != null);
  const braces = nesting.length
    ? `{${nesting.map((key) => `${key}=${b.attrs[key]}`).join(",")}}`
    : "";
  return `${kind}${braces}:${t}`;
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export type Word = { t: string; em: boolean; strong: boolean; dot: boolean };
/** A block's permanent id, as an editor would keep it: a split's first part keeps it, a copy gets a new one. */
type Ided = { id: string };
export type GBlock =
  | (Ided & {
      kind: "text";
      type: "paragraph" | "heading";
      level: number;
      /** `-` is a list item, `>` a quoted paragraph. */
      path: "" | "-" | ">";
      words: Word[];
      origins: number[];
    })
  | (Ided & { kind: "figure"; alt: string; origins: number[] })
  | (Ided & { kind: "rule"; origins: number[] })
  // A table's cells in row order (`cols` per row).
  | (Ided & {
      kind: "container";
      units: Word[][];
      /** The id of each unit's paragraph, and of each table row. */
      unitIds: string[];
      rowIds: string[];
      cols: number;
      origins: number[];
      /** A table's `align`. */
      attrs: { align: "center" | null };
    });

export type OpName =
  | "replaceWord"
  | "insertWords"
  | "deleteWords"
  | "toggleMark"
  | "split"
  | "merge"
  | "insertBlock"
  | "deleteBlock"
  | "moveBlock"
  | "setType"
  | "insertFigure"
  | "insertRule"
  | "editUnit"
  | "addUnit"
  | "dropUnit"
  | "editAttr"
  | "repeatBlock";

export interface Script {
  ops: OpName[];
  touched: Set<number>; // base block ids this side's own ops touched
  moved: Set<number>; // base block ids this side moved
  edited: Set<number>; // base block ids this side touched other than by moving
  structural: boolean; // split, merged or deleted a block
  restructured: Set<number>; // base block ids this side split, merged or deleted
}

export interface Scenario {
  base: GBlock[];
  live: GBlock[];
  draft: GBlock[];
  shared: Script;
  liveScript: Script;
  draftScript: Script;
  repeats: boolean; // some text is deliberately not unique
  copied: Set<string>; // words a repeatBlock op copied: their text no longer names one word
}

export interface GenOptions {
  blocks?: number;
  maxOps?: number;
  sharedP?: number;
  moveP?: number;
  repeats?: boolean;
  ops?: OpName[]; // restrict op mix
}

let counter = 0;
let idCounter = 0;
const newId = () => `g${++idCounter}`;
const copiedWords = new Set<string>();
const fresh = (): Word => ({ t: `w${++counter}`, em: false, strong: false, dot: false });

export function resetWords(start = 0) {
  counter = start;
  idCounter = start;
  copiedWords.clear();
}

function textBlock(rng: Rng, n: number, origins: number[]): GBlock {
  const words = Array.from({ length: n }, () => {
    const w = fresh();
    w.em = rng.chance(0.1);
    w.dot = rng.chance(0.2);
    return w;
  });
  const heading = rng.chance(0.15);
  return {
    kind: "text",
    id: newId(),
    type: heading ? "heading" : "paragraph",
    level: heading ? 1 + rng.int(3) : 1,
    path: heading ? "" : rng.pick(["", "", "", "-", ">"] as const),
    words,
    origins,
  };
}

function container(rng: Rng, origins: number[]): GBlock {
  const cols = 2 + rng.int(2);
  const rows = 1 + rng.int(3);
  const units = Array.from({ length: rows * cols }, () => unit(rng));
  return {
    kind: "container",
    id: newId(),
    units,
    unitIds: units.map(newId),
    rowIds: Array.from({ length: rows }, newId),
    cols,
    origins,
    attrs: { align: null },
  };
}

const unit = (rng: Rng): Word[] =>
  Array.from({ length: 1 + rng.int(4) }, () => {
    const w = fresh();
    w.dot = rng.chance(0.2);
    return w;
  });

export function genBase(rng: Rng, nBlocks: number): GBlock[] {
  const out: GBlock[] = [];
  for (let i = 0; i < nBlocks; i++) {
    const r = rng.next();
    if (r < 0.06) out.push({ kind: "figure", id: newId(), alt: `fig${++counter}`, origins: [i] });
    else if (r < 0.1) out.push({ kind: "rule", id: newId(), origins: [i] });
    else if (r < 0.2) out.push(container(rng, [i]));
    else out.push(textBlock(rng, 2 + rng.int(7), [i]));
    // A paragraph with a figure or container right after it: a side that deletes the paragraph and
    // changes what follows puts the two in one replaced run.
    if (out.at(-1)?.kind === "text" && rng.chance(0.15))
      out.push(
        rng.chance(0.4)
          ? { kind: "figure", id: newId(), alt: `fig${++counter}`, origins: [i] }
          : container(rng, [i]),
      );
  }
  return out;
}

const clone = (bs: GBlock[]): GBlock[] =>
  bs.map((b) =>
    b.kind === "text"
      ? { ...b, words: b.words.map((w) => ({ ...w })), origins: [...b.origins] }
      : b.kind === "container"
        ? {
            ...b,
            units: b.units.map((u) => u.map((w) => ({ ...w }))),
            unitIds: [...b.unitIds],
            rowIds: [...b.rowIds],
            attrs: { ...b.attrs },
            origins: [...b.origins],
          }
        : { ...b, origins: [...b.origins] },
  );

const ALL_OPS: OpName[] = [
  "replaceWord",
  "insertWords",
  "deleteWords",
  "toggleMark",
  "split",
  "merge",
  "insertBlock",
  "deleteBlock",
  "moveBlock",
  "setType",
  "insertFigure",
  "insertRule",
  "editUnit",
  "addUnit",
  "dropUnit",
  "editAttr",
];

/** Applies one random op in place; returns the op name or null if it didn't apply. */
function applyOp(rng: Rng, doc: GBlock[], sc: Script, opts: GenOptions): OpName | null {
  const touched = new Set<number>();
  const op = applyOpInner(rng, doc, touched, opts);
  for (const id of touched) {
    sc.touched.add(id);
    (op === "moveBlock" ? sc.moved : sc.edited).add(id);
  }
  if (op === "split" || op === "merge" || op === "deleteBlock") {
    sc.structural = true;
    for (const id of touched) sc.restructured.add(id);
  }
  return op;
}

function applyOpInner(
  rng: Rng,
  doc: GBlock[],
  touched: Set<number>,
  opts: GenOptions,
): OpName | null {
  const mix = opts.ops ?? [
    ...ALL_OPS,
    ...(opts.repeats ? (["repeatBlock", "repeatBlock"] as OpName[]) : []),
  ];
  const weights: Partial<Record<OpName, number>> = {
    replaceWord: 3,
    insertWords: 3,
    deleteWords: 2,
    toggleMark: 1.5,
    split: 1.2,
    merge: 1.2,
    insertBlock: 1.5,
    deleteBlock: 1,
    moveBlock: (opts.moveP ?? 0.15) * 10,
    setType: 0.8,
    insertFigure: 0.3,
    insertRule: 0.3,
    editUnit: 1.5,
    addUnit: 0.6,
    dropUnit: 0.6,
    editAttr: 0.6,
    repeatBlock: 1,
  };
  const total = mix.reduce((s, o) => s + (weights[o] ?? 1), 0);
  let r = rng.next() * total;
  let op = mix[0];
  for (const o of mix) {
    r -= weights[o] ?? 1;
    if (r <= 0) {
      op = o;
      break;
    }
  }
  const touch = (b: GBlock) => {
    for (const o of b.origins) touched.add(o);
  };
  const texts = doc.map((b, i) => [b, i] as const).filter(([b]) => b.kind === "text") as Array<
    readonly [Extract<GBlock, { kind: "text" }>, number]
  >;
  const containers = doc.filter(
    (b): b is Extract<GBlock, { kind: "container" }> => b.kind === "container",
  );
  const withWords = texts.filter(([b]) => b.words.length > 0);
  switch (op) {
    case "replaceWord": {
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      const i = rng.int(b.words.length);
      const w = fresh();
      w.dot = b.words[i].dot;
      b.words[i] = w;
      touch(b);
      return op;
    }
    case "insertWords": {
      if (!texts.length) return null;
      const [b] = rng.pick(texts);
      const at = rng.int(b.words.length + 1);
      b.words.splice(at, 0, ...Array.from({ length: 1 + rng.int(3) }, fresh));
      touch(b);
      return op;
    }
    case "deleteWords": {
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      const at = rng.int(b.words.length);
      b.words.splice(at, 1 + rng.int(Math.min(2, b.words.length - at)));
      touch(b);
      return op;
    }
    case "toggleMark": {
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      const at = rng.int(b.words.length);
      const len = 1 + rng.int(Math.min(3, b.words.length - at));
      const strong = rng.chance(0.3);
      for (let k = at; k < at + len; k++) {
        if (strong) b.words[k].strong = !b.words[k].strong;
        else b.words[k].em = !b.words[k].em;
      }
      touch(b);
      return op;
    }
    case "split": {
      const cands = texts.filter(([b]) => b.words.length >= 2);
      if (!cands.length) return null;
      const [b, i] = rng.pick(cands);
      const k = 1 + rng.int(b.words.length - 1);
      const tail = b.words.splice(k);
      doc.splice(i + 1, 0, {
        kind: "text",
        id: newId(),
        type: "paragraph",
        level: 1,
        path: b.path,
        words: tail,
        origins: [...b.origins],
      });
      touch(b);
      return op;
    }
    case "merge": {
      const cands = texts.filter(([, i]) => i + 1 < doc.length && doc[i + 1].kind === "text");
      if (!cands.length) return null;
      const [b, i] = rng.pick(cands);
      const next = doc[i + 1] as Extract<GBlock, { kind: "text" }>;
      touch(b);
      touch(next);
      b.words.push(...next.words);
      b.origins = [...new Set([...b.origins, ...next.origins])];
      doc.splice(i + 1, 1);
      return op;
    }
    case "insertBlock": {
      doc.splice(rng.int(doc.length + 1), 0, textBlock(rng, 2 + rng.int(4), []));
      return op;
    }
    case "repeatBlock": {
      // Deliberate repeated content: a copy of an existing paragraph (same words) somewhere else.
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      for (const w of b.words) copiedWords.add(w.t);
      doc.splice(rng.int(doc.length + 1), 0, {
        ...b,
        id: newId(),
        words: b.words.map((w) => ({ ...w })),
        origins: [],
      });
      return op;
    }
    case "deleteBlock": {
      if (doc.length <= 1) return null;
      const i = rng.int(doc.length);
      touch(doc[i]);
      doc.splice(i, 1);
      return op;
    }
    case "moveBlock": {
      if (doc.length < 2) return null;
      const i = rng.int(doc.length);
      const [b] = doc.splice(i, 1);
      let j = rng.int(doc.length + 1);
      if (j === i) j = (j + 1) % (doc.length + 1);
      doc.splice(j, 0, b);
      touch(b);
      return op;
    }
    case "setType": {
      if (!texts.length) return null;
      const [b] = rng.pick(texts);
      if (rng.chance(0.3) && b.type === "paragraph") b.path = rng.pick(["", "-", ">"] as const);
      else if (b.type === "heading") b.type = "paragraph";
      else {
        b.type = "heading";
        b.path = "";
        b.level = 1 + rng.int(3);
      }
      touch(b);
      return op;
    }
    case "editUnit": {
      if (!containers.length) return null;
      const b = rng.pick(containers);
      const u = rng.pick(b.units);
      if (rng.chance(0.5) && u.length) u[rng.int(u.length)] = fresh();
      else u.splice(rng.int(u.length + 1), 0, fresh());
      touch(b);
      return op;
    }
    case "addUnit": {
      if (!containers.length) return null;
      const b = rng.pick(containers);
      // A table grows by a row or a column, so live adding one and the draft the other is generated.
      if (rng.chance(0.4)) {
        const rows = b.units.length / b.cols;
        const units: Word[][] = [];
        const ids: string[] = [];
        for (let r = 0; r < rows; r++) {
          units.push(...b.units.slice(r * b.cols, (r + 1) * b.cols), unit(rng));
          ids.push(...b.unitIds.slice(r * b.cols, (r + 1) * b.cols), newId());
        }
        b.units = units;
        b.unitIds = ids;
        b.cols++;
      } else {
        const row = rng.int(b.units.length / b.cols + 1);
        const at = row * b.cols;
        b.units.splice(at, 0, ...Array.from({ length: b.cols }, () => unit(rng)));
        b.unitIds.splice(at, 0, ...Array.from({ length: b.cols }, newId));
        b.rowIds.splice(row, 0, newId());
      }
      touch(b);
      return op;
    }
    case "dropUnit": {
      const cands = containers.filter((b) => b.units.length > b.cols);
      if (!cands.length) return null;
      const b = rng.pick(cands);
      const row = rng.int(b.units.length / b.cols);
      b.units.splice(row * b.cols, b.cols);
      b.unitIds.splice(row * b.cols, b.cols);
      b.rowIds.splice(row, 1);
      touch(b);
      return op;
    }
    case "editAttr": {
      if (!containers.length) return null;
      const b = rng.pick(containers);
      b.attrs.align = b.attrs.align ? null : "center";
      touch(b);
      return op;
    }
    case "insertFigure": {
      doc.splice(rng.int(doc.length + 1), 0, {
        kind: "figure",
        id: newId(),
        alt: `fig${++counter}`,
        origins: [],
      });
      return op;
    }
    case "insertRule": {
      doc.splice(rng.int(doc.length + 1), 0, { kind: "rule", id: newId(), origins: [] });
      return op;
    }
  }
  return null;
}

export function runScript(rng: Rng, doc: GBlock[], n: number, opts: GenOptions): Script {
  const s: Script = {
    ops: [],
    touched: new Set(),
    moved: new Set(),
    edited: new Set(),
    structural: false,
    restructured: new Set(),
  };
  for (let k = 0; k < n; k++) {
    const op = applyOp(rng, doc, s, opts);
    if (op) s.ops.push(op);
  }
  return s;
}

/** Scenario features the spec treats as known limitations, so failures are bucketed apart. */
export function limitations(sc: Scenario): string[] {
  const out: string[] = [];
  if (sc.shared.ops.length) out.push("same-edit-both-sides");
  const [l, d] = [sc.liveScript, sc.draftScript];
  const selfRestructured = [l, d].some((x) => [...x.moved].some((id) => x.restructured.has(id)));
  if ((l.moved.size && d.structural) || (d.moved.size && l.structural) || selfRestructured)
    out.push("move-vs-restructure");
  return out;
}

export function genScenario(rng: Rng, opts: GenOptions = {}): Scenario {
  const base = genBase(rng, opts.blocks ?? 3 + rng.int(10));
  const mid = clone(base);
  const shared = runScript(rng, mid, rng.chance(opts.sharedP ?? 0.25) ? 1 + rng.int(2) : 0, opts);
  const live = clone(mid);
  const draft = clone(mid);
  const maxOps = opts.maxOps ?? 4;
  const liveScript = runScript(rng, live, rng.int(maxOps + 1), opts);
  const draftScript = runScript(rng, draft, rng.int(maxOps + 1), opts);
  return {
    base,
    live,
    draft,
    shared,
    liveScript,
    draftScript,
    repeats: !!opts.repeats,
    copied: new Set(copiedWords),
  };
}

export function toPM(schema: Schema, doc: GBlock[]): PMNode[] {
  return doc.map((b) => {
    if (b.kind === "figure")
      return schema.nodes.figure.create({ src: `asset:${b.alt}`, alt: b.alt, id: b.id });
    if (b.kind === "rule") return schema.nodes.horizontal_rule.create({ id: b.id });
    if (b.kind === "container") {
      const { nodes } = schema;
      const para = (u: Word[], k: number) =>
        nodes.paragraph.create({ id: b.unitIds[k] }, wordNodes(schema, u));
      const rows: PMNode[] = [];
      for (let r = 0; r < b.units.length; r += b.cols)
        rows.push(
          nodes.table_row.create(
            { id: b.rowIds[r / b.cols] },
            b.units
              .slice(r, r + b.cols)
              .map((u, k) => nodes.table_cell.create(null, para(u, r + k))),
          ),
        );
      return nodes.table.create({ align: b.attrs.align, id: b.id }, rows);
    }
    const content = wordNodes(schema, b.words);
    const attrs = {
      id: b.id,
      ...(b.type === "heading" ? { level: b.level } : {}),
      ...(b.path === "-" ? { path: "-", marker: "item" } : b.path ? { path: b.path } : {}),
    };
    return schema.nodes.paragraph.create(attrs, content);
  });
}

function wordNodes(schema: Schema, words: readonly Word[]): PMNode[] {
  const inline: PMNode[] = [];
  words.forEach((w, i) => {
    if (i > 0) inline.push(schema.text(" "));
    const marks = [
      ...(w.em ? [schema.marks.em.create()] : []),
      ...(w.strong ? [schema.marks.strong.create()] : []),
    ];
    inline.push(schema.text(w.t, marks));
    if (w.dot) inline.push(schema.text("."));
  });
  return joinAdjacent(inline);
}

function joinAdjacent(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (prev?.sameMarkup(n))
      out[out.length - 1] = prev.type.schema.text(`${prev.text}${n.text}`, prev.marks);
    else out.push(n);
  }
  return out;
}

// Han characters are words of their own (the tokens segment them), as in production.
const WORD = /\p{sc=Han}|[\p{L}\p{N}_]+/gu;

export interface WordInfo {
  pos: number;
  block: number;
  em: boolean;
  strong: boolean;
  type: string;
  first: boolean;
}

export function wordsOf(blocks: readonly PMNode[]): {
  list: string[];
  info: Map<string, WordInfo>;
  count: Map<string, number>;
} {
  const list: string[] = [];
  const info = new Map<string, WordInfo>();
  const count = new Map<string, number>();
  blocks.forEach((b, bi) => {
    const type = b.attrs.level != null ? `heading${b.attrs.level}` : b.type.name;
    let first = b.isTextblock;
    const add = (w: string, em: boolean, strong: boolean) => {
      count.set(w, (count.get(w) ?? 0) + 1);
      info.set(w, { pos: list.length, block: bi, em, strong, type, first });
      list.push(w);
      first = false;
    };
    // Words inside a list, quote or table count, with the container's block index.
    const walk = (node: PMNode) => {
      if (node.type.name === "figure") add(`fig:${node.attrs.alt}`, false, false);
      node.forEach((n) => {
        if (!n.isText) {
          walk(n);
          return;
        }
        const em = n.marks.some((m) => m.type.name === "em");
        const strong = n.marks.some((m) => m.type.name === "strong");
        for (const m of (n.text ?? "").matchAll(WORD)) add(m[0], em, strong);
      });
    };
    walk(b);
  });
  return { list, info, count };
}

export function tokWords(toks: readonly Tok[]): string[] {
  const out: string[] = [];
  for (const t of toks) {
    if (t.kind === "text") for (const m of t.core.matchAll(WORD)) out.push(m[0]);
    else if (t.kind === "atom") {
      const visit = (n: PMNode) => {
        if (n.type.name === "figure") out.push(`fig:${n.attrs.alt}`);
        else if (n.isText) for (const m of (n.text ?? "").matchAll(WORD)) out.push(m[0]);
      };
      visit(t.node);
      t.node.descendants((n) => {
        visit(n);
      });
    }
  }
  return out;
}

export interface OracleInput {
  base: readonly PMNode[];
  live: readonly PMNode[];
  draft: readonly PMNode[];
  merged: readonly PMNode[];
  conflicts: readonly Conflict[];
  liveTouched?: Set<number>; // ground truth; omit to skip the legitimacy check
  draftTouched?: Set<number>;
  pairSamples?: number;
  orderConflict?: boolean; // the sides' moves admit no single order; the draft's order is used
  ambiguous?: Set<string>; // words known to have been copied, so their text doesn't name one word
}

export function check(o: OracleInput, rnd: () => number = Math.random): string[] {
  const B = wordsOf(o.base);
  const L = wordsOf(o.live);
  const D = wordsOf(o.draft);
  const M = wordsOf(o.merged);
  const fails: string[] = [];
  const fail = (s: string) => {
    if (fails.length < 12) fails.push(s);
  };
  const conflictWords = new Set<string>();
  const conflictBlocks = new Set<number>();
  for (const c of o.conflicts) {
    for (const w of [...tokWords(c.base), ...tokWords(c.live), ...tokWords(c.draft)])
      conflictWords.add(w);
    for (const id of c.baseIds) conflictBlocks.add(id);
  }
  // A word repeated in any version has no single identity; only count checks apply to it.
  const repeated = new Set<string>();
  for (const v of [B, L, D]) for (const [w, n] of v.count) if (n > 1) repeated.add(w);
  for (const w of o.ambiguous ?? []) repeated.add(w);
  const inConflictBlock = (w: string) => {
    const b = B.info.get(w);
    return b !== undefined && conflictBlocks.has(b.block);
  };
  const excused = (w: string) => conflictWords.has(w) || inConflictBlock(w);

  for (const [w, n] of M.count) {
    if (!B.count.has(w) && !L.count.has(w) && !D.count.has(w)) fail(`invented ${w}`);
    if (!repeated.has(w) && n > 1 && !excused(w)) fail(`duplicated ${w} x${n}`);
    if (repeated.has(w)) {
      const cb = B.count.get(w) ?? 0;
      const cl = L.count.get(w) ?? 0;
      const cd = D.count.get(w) ?? 0;
      if (n > cb + Math.max(0, cl - cb) + Math.max(0, cd - cb) && !excused(w))
        fail(`repeated ${w}: ${n} copies from b${cb} l${cl} d${cd}`);
    }
  }
  for (const [w, cd] of D.count) {
    const cb = B.count.get(w) ?? 0;
    const cl = L.count.get(w) ?? 0;
    const cm = M.count.get(w) ?? 0;
    if (repeated.has(w)) {
      if (cd > cb && cm < cd - Math.max(0, cb - cl))
        fail(`draft copy of repeated ${w} lost: m${cm} d${cd} b${cb} l${cl}`);
      continue;
    }
    if (!cb && !cm) fail(`draft insertion lost: ${w}`);
    // A word live moved into a conflict region shows red there (live has it, the draft doesn't).
    if (cb && cl && !cm && !conflictWords.has(w)) fail(`kept-by-both word lost: ${w}`);
    if (cb && !cl && cm && !inConflictBlock(w)) fail(`resurrected live deletion: ${w}`);
  }
  for (const [w] of B.count) {
    if (repeated.has(w)) continue;
    if (!D.count.has(w) && M.count.has(w) && !inConflictBlock(w))
      fail(`draft deletion undone: ${w}`);
  }
  for (const [w] of L.count) {
    if (repeated.has(w) || B.count.has(w)) continue;
    if (!M.count.has(w) && !conflictWords.has(w)) fail(`live insertion dropped: ${w}`);
  }
  const { liveTouched, draftTouched } = o;
  if (liveTouched && draftTouched) {
    for (const c of o.conflicts) {
      if (!c.baseIds.some((id) => liveTouched.has(id) && draftTouched.has(id)))
        fail(
          `conflict on blocks [${c.baseIds}] neither both sides touched: live ${tokWords(c.live).join(" ")} / draft ${tokWords(c.draft).join(" ")}`,
        );
    }
  }

  // Attributes, order and block structure, for identifiable words outside conflicts.
  const ok = (w: string) => !repeated.has(w) && !excused(w) && (M.count.get(w) ?? 0) === 1;
  const rule = <T>(b: T, l: T, d: T) => (l === b ? d : d === b ? l : d);
  for (const w of M.list) {
    if (!ok(w)) continue;
    const m = M.info.get(w);
    if (!m) throw new Error(`merged word ${w} has no info`);
    const b = B.info.get(w);
    const l = L.info.get(w);
    const d = D.info.get(w);
    for (const attr of ["em", "strong"] as const) {
      let exp: boolean | undefined;
      if (b && l && d) exp = rule(b[attr], l[attr], d[attr]);
      else if (l && !d) exp = l[attr];
      else if (d && !l) exp = d[attr];
      else if (l && d && l[attr] === d[attr]) exp = l[attr];
      if (exp !== undefined && m[attr] !== exp)
        fail(`${attr} on ${w}: got ${m[attr]}, want ${exp}`);
    }
    if (b && l && d && b.first && l.first && d.first && m.first) {
      const exp = rule(b.type, l.type, d.type);
      if (m.type !== exp) fail(`block type at ${w}: got ${m.type}, want ${exp}`);
    }
  }
  const pairExp = (
    u: string,
    v: string,
    f: (x: WordInfo, y: WordInfo) => boolean,
  ): boolean | undefined => {
    const [bu, bv, lu, lv, du, dv] = [
      B.info.get(u),
      B.info.get(v),
      L.info.get(u),
      L.info.get(v),
      D.info.get(u),
      D.info.get(v),
    ];
    const inB = bu && bv;
    const inL = lu && lv;
    const inD = du && dv;
    if (inB && inL && inD) return rule(f(bu, bv), f(lu, lv), f(du, dv));
    // One-sided words: only within one block of that side, where the side's order is unambiguous.
    if (inL && !inD && lu.block === lv.block) return f(lu, lv);
    if (inD && !inL && du.block === dv.block) return f(du, dv);
    if (inL && inD && !inB && f(lu, lv) === f(du, dv)) return f(lu, lv);
    return undefined;
  };
  const ids = M.list.filter(ok);
  const samples = o.pairSamples ?? 200;
  const pairs: Array<[string, string]> = [];
  if (ids.length * ids.length <= samples * 2) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
  } else {
    for (let k = 0; k < samples; k++) {
      const i = Math.floor(rnd() * ids.length);
      const j = Math.floor(rnd() * ids.length);
      if (i !== j) pairs.push([ids[Math.min(i, j)], ids[Math.max(i, j)]]);
    }
  }
  for (const [u, v] of o.orderConflict ? [] : pairs) {
    const exp = pairExp(u, v, (x, y) => x.pos < y.pos);
    if (exp === false) fail(`order: ${u} before ${v}, want after`);
  }
  for (let i = 0; i + 1 < M.list.length; i++) {
    const [u, v] = [M.list[i], M.list[i + 1]];
    if (!ok(u) || !ok(v)) continue;
    // Only base words: where a one-sided word lands relative to the other side's new paragraph
    // break at the same point is a presentation choice (words first), not an invariant.
    if (!B.info.has(u) || !B.info.has(v)) continue;
    const exp = pairExp(u, v, (x, y) => x.block === y.block);
    const [mu, mv] = [M.info.get(u), M.info.get(v)];
    if (!mu || !mv) throw new Error(`merged words ${u}, ${v} have no info`);
    const got = mu.block === mv.block;
    if (exp !== undefined && exp !== got) fail(`blocks: ${u}|${v} same=${got}, want ${exp}`);
  }
  return fails;
}

export const show = (bs: readonly PMNode[]) =>
  bs
    .map(
      (b) =>
        `${b.attrs.level != null ? `h${b.attrs.level}` : b.type.name === "paragraph" ? "p" : b.type.name}[${b.type.name === "figure" ? b.attrs.alt : b.textContent}]`,
    )
    .join(" ");

export interface Case {
  row: string; // case-table row
  name: string;
  base: string;
  live: string;
  draft: string;
  merged: string;
  conflicts: number;
}

const LIN = "p#lin:Lin Feng drew his sword and stepped forward.";
const ELDER = "p#eld:The elder watched him with cold eyes.";
const THUNDER = "p#thu:Thunder rolled across the peak.";
const FAR =
  "p#f1:Rain fell on the old road. | p#f2:The lamp burned low tonight. | p#f3:Wind moved through the pines. | p#f4:A dog barked far away.";
const FARM =
  "p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away.";
const P3 = `${LIN} | ${ELDER} | ${THUNDER}`;
const SIX = ["aa", "bb", "cc", "dd", "ee", "ff"].map((w) => `p#${w}:${w} ${w} ${w}`);

export const CASES: Case[] = [
  // Pairing by id (identity/design.md section 3)
  {
    row: "a piece never moves its pair",
    name: "id-pair-beside-piece",
    base: "p#A:one two",
    live: "p#X:one | p#A:two",
    draft: "p#A:one two DRAFT",
    merged: "p:one | p:two DRAFT",
    conflicts: 0,
  },
  {
    row: "a far addition beside a short line the draft edited",
    name: "id-far-addition",
    base: `p#n:No. | ${FAR} | p#z:The door stayed shut.`,
    live: `${FAR} | p#x:No, she said quietly. | p#z:The door stayed shut.`,
    draft: `p#n:No! | ${FAR} | p#z:The door stayed shut.`,
    merged: `p:No! | ${FARM} | p:No, she said quietly. | p:The door stayed shut.`,
    conflicts: 1,
  },
  {
    row: "a far addition beside a short line the draft edited, an unchanged twin",
    name: "id-far-addition-twin",
    base: `p#n:No. | ${FAR} | p#t:No. | p#z:The door stayed shut.`,
    live: `${FAR} | p#t:No. | p#x:No, she said quietly. | p#z:The door stayed shut.`,
    draft: `p#n:No! | ${FAR} | p#t:No. | p#z:The door stayed shut.`,
    merged: `p:No! | ${FARM} | p:No. | p:No, she said quietly. | p:The door stayed shut.`,
    conflicts: 1,
  },
  {
    row: "an item joined into another, a lookalike item added, the draft split the joined one",
    name: "id-items-join-split",
    base: "list:a b c d#A;e f g#B",
    live: "list:x f g y#N;a b c d e f g#A",
    draft: "list:a b c d#A;e#B;f g#C",
    merged: "list:x f g y;a b c d;e;f g",
    conflicts: 1,
  },
  {
    row: "a block deleted and another typed, against an appended word",
    name: "id-deleted-and-typed",
    base: "p#m:Mara opened the door",
    live: "p#n:Rain fell on the roof",
    draft: "p#m:Mara opened the door tonight",
    merged: "p:Rain fell on the roof | p:Mara opened the door tonight",
    conflicts: 1,
  },
  {
    row: "the draft moves a block live deleted",
    name: "id-draft-moves-live-deletes",
    base: "p#a:aa bb | p#b:cc dd | p#c:ee ff",
    live: "p#a:aa bb | p#c:ee ff",
    draft: "p#a:aa bb | p#c:ee ff | p#b:cc dd",
    merged: "p:aa bb | p:ee ff | p:cc dd",
    conflicts: 1,
  },
  {
    row: "the draft moves and edits a block live deleted",
    name: "id-draft-moves-edits-live-deletes",
    base: "p#a:aa bb | p#b:cc dd | p#c:ee ff",
    live: "p#a:aa bb | p#c:ee ff",
    draft: "p#a:aa bb | p#c:ee ff | p#b:cc DD",
    merged: "p:aa bb | p:ee ff | p:cc DD",
    conflicts: 1,
  },
  {
    row: "live moves a block the draft deleted",
    name: "id-live-moves-draft-deletes",
    base: "p#a:aa bb | p#b:cc dd | p#c:ee ff",
    live: "p#a:aa bb | p#c:ee ff | p#b:cc dd",
    draft: "p#a:aa bb | p#c:ee ff",
    merged: "p:aa bb | p:ee ff",
    conflicts: 1,
  },
  {
    row: "two blocks swapped, the draft edits one",
    name: "id-swap-edit-travels",
    base: "p#a:aa bb | p#b:cc dd",
    live: "p#b:cc dd | p#a:aa bb",
    draft: "p#a:aa BB | p#b:cc dd",
    merged: "p:cc dd | p:aa BB",
    conflicts: 0,
  },
  {
    row: "the same block typed on both sides",
    name: "id-typed-twice",
    base: "p#a:x y",
    live: "p#a:x y | p#n1:new para here",
    draft: "p#a:x y | p#n2:new para here",
    merged: "p:x y | p:new para here",
    conflicts: 0,
  },
  // Text in one paragraph
  {
    row: "same word, different edits",
    name: "word-conflict",
    base: "p:The cat sat on the mat.",
    live: "p:The dog sat on the mat.",
    draft: "p:The bird sat on the mat.",
    merged: "p:The bird sat on the mat.",
    conflicts: 1,
  },
  {
    row: "same word, same edit",
    name: "word-same",
    base: "p:The cat sat.",
    live: "p:The dog sat.",
    draft: "p:The dog sat.",
    merged: "p:The dog sat.",
    conflicts: 0,
  },
  {
    row: "same paragraph, different words",
    name: "para-different-words",
    base: "p:The cat sat on the mat.",
    live: "p:The dog sat on the mat.",
    draft: "p:The cat sat on the rug.",
    merged: "p:The dog sat on the rug.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, equal",
    name: "insert-equal",
    base: "p:She ran.",
    live: "p:She ran home.",
    draft: "p:She ran home.",
    merged: "p:She ran home.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, different",
    name: "insert-different",
    base: "p:She ran.",
    live: "p:She ran home.",
    draft: "p:She ran fast.",
    merged: "p:She ran home fast.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, different",
    name: "insert-paragraphs-different",
    base: "p:One. | p:Two.",
    live: "p:One. | p:Rain fell. | p:Two.",
    draft: "p:One. | p:Wind rose. | p:Two.",
    merged: "p:One. | p:Rain fell. | p:Wind rose. | p:Two.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, equal",
    name: "insert-paragraphs-equal",
    base: "p:One. | p:Two.",
    live: "p:One. | p:New para. | p:Two.",
    draft: "p:One. | p:New para. | p:Two.",
    merged: "p:One. | p:New para. | p:Two.",
    conflicts: 0,
  },
  {
    row: "edit vs delete, same words",
    name: "replace-vs-delete",
    base: "p:a b c d",
    live: "p:a X d",
    draft: "p:a d",
    merged: "p:a d",
    conflicts: 1,
  },
  // Repeated content
  {
    row: "repeated content",
    name: "repeated-paragraphs",
    base: "p:He nodded. | p:She left the room. | p:He nodded.",
    live: "p:He nodded. | p:She left the room. | p:He nodded slowly.",
    draft: "p:He frowned. | p:She left the room. | p:He nodded.",
    merged: "p:He frowned. | p:She left the room. | p:He nodded slowly.",
    conflicts: 0,
  },
  {
    row: "repeated content",
    name: "repeated-sentences",
    base: "p:He nodded. She left. He nodded.",
    live: "p:He nodded. She left. He nodded slowly.",
    draft: "p:He frowned. She left. He nodded.",
    merged: "p:He frowned. She left. He nodded slowly.",
    conflicts: 0,
  },
  // Structure
  {
    row: "split vs edit",
    name: "live-split-draft-edit",
    base: "p:one two three four",
    live: "p:one two | p:three four",
    draft: "p:one TWO three four",
    merged: "p:one TWO | p:three four",
    conflicts: 0,
  },
  {
    row: "merge vs edit",
    name: "live-join-draft-edit",
    base: "p:one two | p:three four",
    live: "p:one two three four",
    draft: "p:one two | p:three FOUR",
    merged: "p:one two three FOUR",
    conflicts: 0,
  },
  {
    row: "merge vs edit",
    name: "draft-join-live-edit",
    base: "p:one two | p:three four",
    live: "p:one two | p:three FOUR",
    draft: "p:one two three four",
    merged: "p:one two three FOUR",
    conflicts: 0,
  },
  {
    row: "split on both sides",
    name: "split-same",
    base: "p:one two three four",
    live: "p:one two | p:three four",
    draft: "p:one two | p:three four",
    merged: "p:one two | p:three four",
    conflicts: 0,
  },
  {
    row: "split on both sides",
    name: "split-different",
    base: "p:one two three four",
    live: "p:one two | p:three four",
    draft: "p:one | p:two three four",
    merged: "p:one | p:two three four",
    conflicts: 1,
  },
  {
    row: "merge vs split",
    name: "join-vs-split",
    base: "p:one two | p:three four",
    live: "p:one two three four",
    draft: "p:one two | p:three | p:four",
    merged: "p:one two | p:three | p:four",
    conflicts: 1,
  },
  {
    row: "delete paragraph vs join onto it",
    name: "delete-vs-join",
    base: "p:aa bb cc | p:dd ee ff | p:gg hh",
    live: "p:aa bb cc | p:gg hh",
    draft: "p:aa bb cc dd ee ff | p:gg hh",
    merged: "p:aa bb cc dd ee ff | p:gg hh",
    conflicts: 1,
  },
  // Moves
  {
    row: "live moves, draft edits",
    name: "live-move-draft-edit",
    base: P3,
    live: `${THUNDER} | ${LIN} | ${ELDER}`,
    draft: `${LIN} | ${ELDER} | p#thu:Thunder rolled across the silent peak.`,
    merged: `p:Thunder rolled across the silent peak. | ${LIN} | ${ELDER}`,
    conflicts: 0,
  },
  {
    row: "draft moves, live edits",
    name: "draft-move-live-edit",
    base: P3,
    live: `${LIN} | ${ELDER} | p#thu:Thunder rolled across the silent peak.`,
    draft: `${THUNDER} | ${LIN} | ${ELDER}`,
    merged: `p:Thunder rolled across the silent peak. | ${LIN} | ${ELDER}`,
    conflicts: 0,
  },
  {
    row: "adjacent swap on one side, move on the other",
    name: "swap-ambiguity",
    base: P3,
    live: `${THUNDER} | ${LIN} | ${ELDER}`,
    draft: `${LIN} | ${THUNDER} | ${ELDER}`,
    merged: `${THUNDER} | ${LIN} | ${ELDER}`,
    conflicts: 0,
  },
  {
    row: "both move one paragraph to different places",
    name: "move-move",
    base: SIX.join(" | "),
    live: [SIX[0], SIX[2], SIX[3], SIX[4], SIX[1], SIX[5]].join(" | "),
    draft: [SIX[0], SIX[2], SIX[3], SIX[1], SIX[4], SIX[5]].join(" | "),
    merged: [SIX[0], SIX[2], SIX[3], SIX[1], SIX[4], SIX[5]].join(" | "),
    conflicts: 1,
  },
  {
    row: "moved text (cut and paste)",
    name: "draft-moves-sentence-live-edits-it",
    base: "p:Lin Feng drew his sword. The wind howled. | p:Thunder rolled across the peak.",
    live: "p:Lin Feng drew his sword. The cold wind howled. | p:Thunder rolled across the peak.",
    draft: "p:Lin Feng drew his sword. | p:Thunder rolled across the peak. The wind howled.",
    merged: "p:Lin Feng drew his sword. | p:Thunder rolled across the peak. The wind howled.",
    conflicts: 2,
  },
  {
    row: "moved text (cut and paste)",
    name: "live-moves-sentence-draft-edits-it",
    base: "p:Lin Feng drew his sword. The wind howled. | p:Thunder rolled across the peak.",
    live: "p:Lin Feng drew his sword. | p:Thunder rolled across the peak. The wind howled.",
    draft: "p:Lin Feng drew his sword. The cold wind howled. | p:Thunder rolled across the peak.",
    merged: "p:Lin Feng drew his sword. The cold wind howled. | p:Thunder rolled across the peak.",
    conflicts: 2,
  },
  // Delete vs edit
  {
    row: "live deletes, draft edits",
    name: "live-delete-draft-edit",
    base: P3,
    live: `${LIN} | ${THUNDER}`,
    draft: `${LIN} | p:The elder watched him with icy eyes. | ${THUNDER}`,
    merged: `${LIN} | p:The elder watched him with icy eyes. | ${THUNDER}`,
    conflicts: 1,
  },
  {
    row: "draft deletes, live edits",
    name: "draft-delete-live-edit",
    base: P3,
    live: `${LIN} | p:The elder watched him with icy eyes. | ${THUNDER}`,
    draft: `${LIN} | ${THUNDER}`,
    merged: `${LIN} | ${THUNDER}`,
    conflicts: 1,
  },
  {
    row: "draft deletes, live appends",
    name: "draft-delete-live-append",
    base: "p:a b | p:c d | p:f g",
    live: "p:a b | p:c d e | p:f g",
    draft: "p:a b | p:f g",
    merged: "p:a b | p:f g",
    conflicts: 1,
  },
  {
    row: "draft deletes everything",
    name: "draft-empties",
    base: "p:a b | p:c d",
    live: "p:a b | p:c d e",
    draft: "p:",
    merged: "p:",
    conflicts: 1,
  },
  {
    row: "live deletes everything",
    name: "live-empties",
    base: "p:a b | p:c d",
    live: "p#new:",
    draft: "p:a b | p:c d e",
    merged: "p: | p:c d e",
    conflicts: 1,
  },
  {
    row: "both delete",
    name: "both-delete",
    base: P3,
    live: `${LIN} | ${THUNDER}`,
    draft: `${LIN} | ${THUNDER}`,
    merged: `${LIN} | ${THUNDER}`,
    conflicts: 0,
  },
  // Block type, marks, attrs
  {
    row: "block type vs text",
    name: "heading-vs-text",
    base: "p:Chapter One | p:Body text here.",
    live: "h2:Chapter One | p:Body text here.",
    draft: "p:Chapter One: Dawn | p:Body text here.",
    merged: "h2:Chapter One: Dawn | p:Body text here.",
    conflicts: 0,
  },
  {
    row: "block type vs block type",
    name: "heading-vs-heading",
    base: "p:Chapter One | p:Body text here.",
    live: "h2:Chapter One | p:Body text here.",
    draft: "h3:Chapter One | p:Body text here.",
    merged: "h3:Chapter One | p:Body text here.",
    conflicts: 1,
  },
  {
    row: "marks: different marks, same word",
    name: "bold-vs-italic",
    base: "p:He said no.",
    live: "p:He said **no**.",
    draft: "p:He said *no*.",
    merged: "p:He said ***no***.",
    conflicts: 0,
  },
  {
    row: "marks: mark vs replace",
    name: "bold-vs-replace",
    base: "p:He said no.",
    live: "p:He said **no**.",
    draft: "p:He said yes.",
    merged: "p:He said yes.",
    conflicts: 1,
  },
  {
    row: "marks: mark vs neighbouring edit",
    name: "link-vs-insert",
    base: "p:See the map.",
    live: "p:See the [map](a).",
    draft: "p:See the old map.",
    merged: "p:See the old [map](a).",
    conflicts: 0,
  },
  {
    row: "attrs vs text",
    name: "align-vs-text",
    base: "p:The end.",
    live: "pc:The end.",
    draft: "p:The very end.",
    merged: "pc:The very end.",
    conflicts: 0,
  },
  // Non-text blocks (atomic)
  {
    row: "figure deleted vs untouched",
    name: "figure-delete",
    base: "p:a b | fig:map | p:c d",
    live: "p:a b | p:c d",
    draft: "p:a b | fig:map | p:c d e",
    merged: "p:a b | p:c d e",
    conflicts: 0,
  },
  {
    row: "figure changed vs deleted",
    name: "figure-alt-vs-delete",
    base: "p:a b | fig:map | p:c d",
    live: "p:a b | fig:map2 | p:c d",
    draft: "p:a b | p:c d",
    merged: "p:a b | p:c d",
    conflicts: 1,
  },
  {
    row: "same rule inserted on both sides",
    name: "hr-both",
    base: "p:a b | p:c d",
    live: "p:a b | hr | p:c d",
    draft: "p:a b | hr | p:c d",
    merged: "p:a b | hr | p:c d",
    conflicts: 0,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "list-items",
    base: "list:one;two;three",
    live: "list:ONE;two;three",
    draft: "list:one;two;THREE",
    merged: "list:ONE;two;THREE",
    conflicts: 0,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "list-item-added",
    base: "list:one;two",
    live: "list:one;two;three",
    draft: "list:ONE;two",
    merged: "list:ONE;two;three",
    conflicts: 0,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "list-same-item",
    base: "list:the cat sat;two",
    live: "list:the dog sat;two",
    draft: "list:the bird sat;two",
    merged: "list:the bird sat;two",
    conflicts: 1,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "quote-paragraphs",
    base: "quote:She said hi.;He left.",
    live: "quote:She said hi.;He left.;Rain fell.",
    draft: "quote:She said hello.;He left.",
    merged: "quote:She said hello.;He left.;Rain fell.",
    conflicts: 0,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "table-cells",
    base: "table:a b,c d;e f,g h",
    live: "table:a B,c d;e f,g h",
    draft: "table:a b,c d;e f,g H",
    merged: "table:a B,c d;e f,g H",
    conflicts: 0,
  },
  {
    row: "edits in one container, merged table not rectangular",
    name: "table-column-vs-row",
    base: "table:a,b",
    live: "table:a,b,x",
    draft: "table:a,b;c,d",
    merged: "table:a,b;c,d",
    conflicts: 1,
  },
  {
    row: "paragraph deleted beside a changed figure",
    name: "figure-after-deleted-paragraph",
    base: "p:intro words here | fig:map | p:c d",
    live: "fig:map2 | p:c d",
    draft: "p:intro words here | fig:map3 | p:c d",
    merged: "fig:map3 | p:c d",
    conflicts: 1,
  },
  {
    row: "paragraph deleted beside a changed list",
    name: "list-after-deleted-paragraph",
    base: "p:intro words here | list:one;two | p:c d",
    live: "list:ONE;two | p:c d",
    draft: "p:intro words here | list:one;TWO | p:c d",
    merged: "list:ONE;TWO | p:c d",
    conflicts: 0,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "table-merged-cell",
    base: "table:alpha^2;c,d",
    live: "table:LIVE^2;c,d",
    draft: "table:alpha^2;c,DRAFT",
    merged: "table:LIVE^2;c,DRAFT",
    conflicts: 0,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "quote-vs-next",
    base: "quote:She said hi. | p:after",
    live: "quote:She said hello. | p:after",
    draft: "quote:She said hi. | p:after that",
    merged: "quote:She said hello. | p:after that",
    conflicts: 0,
  },
  // Block structure settled before words (`draft-wins-stretch`), and pairings nothing settles
  {
    row: "r2 B1: live adds a paragraph between two the draft joined",
    name: "stretch-join-vs-add",
    base: "p:a | p:b c",
    live: "p:a | p:X | p:b c",
    draft: "p:a b c",
    merged: "p:a b c",
    conflicts: 1,
  },
  {
    row: "r2 B1, sides exchanged",
    name: "stretch-add-vs-join",
    base: "p:a | p:b c",
    live: "p:a b c",
    draft: "p:a | p:X | p:b c",
    merged: "p:a | p:X | p:b c",
    conflicts: 1,
  },
  {
    row: "r2 B1: a join and a typed paragraph beside it",
    name: "stretch-join-insert",
    base: "p:a b | p:c d e",
    live: "p:a b | p:NEW | p:c d e",
    draft: "p:a b c d e",
    merged: "p:a b c d e",
    conflicts: 1,
  },
  {
    row: "r2 B1, sides exchanged",
    name: "stretch-insert-join",
    base: "p:a b | p:c d e",
    live: "p:a b c d e",
    draft: "p:a b | p:NEW | p:c d e",
    merged: "p:a b | p:NEW | p:c d e",
    conflicts: 1,
  },
  {
    row: "r2 B1: live joins, the draft keeps the second",
    name: "stretch-join-loss",
    base: "p#a:a | p#b:b c d",
    live: "p#a:a b c d",
    draft: "p#b:b c d",
    merged: "p:b c d",
    conflicts: 1,
  },
  {
    row: "r2 B1: the same with a heading",
    name: "stretch-join-heading",
    base: "p#a:a | h2#b:b c d e f",
    live: "p#a:a b c d e f",
    draft: "h2#b:b c d e f",
    merged: "h2:b c d e f",
    conflicts: 1,
  },
  {
    row: "r2 B1: empty paragraphs before",
    name: "stretch-join-empties",
    base: "p#e1: | p#e2: | p#a:a | h2#b:b c d e f",
    live: "p#e1: | p#e2: | p#a:a b c d e f",
    draft: "p#e1: | p#e2: | h2#b:b c d e f",
    merged: "p: | p: | h2:b c d e f",
    conflicts: 1,
  },
  {
    row: "r2 B1: a reorder and a join",
    name: "stretch-reorder-join",
    base: "p#ab:a b | p#cd:c d | p#e:e",
    live: "p#e:e | p#ab:a b c d",
    draft: "p#cd:c d",
    merged: "p:c d",
    conflicts: 2,
  },
  {
    row: "seed 54: a cut and a paste, both sides",
    name: "stretch-seed-54",
    base: "p:a b c | p:d e f",
    live: "p:a b c | p:f",
    draft: "p:e f | p:a x y z b c",
    merged: "p:e f | p:a x y z b c",
    conflicts: 1,
  },
  {
    row: "r2 B1: repeated short paragraphs, one moved",
    name: "stretch-repeated",
    base: "p#y1:Yes. | p#y2:Yes. | p#m:Maybe.",
    live: "p#y1:Yes. LIVE | p#m:Maybe. | p#y2:Yes.",
    draft: "p#y1:Yes. DRAFT | p#y2:Yes. | p#m:Maybe.",
    merged: "p:Yes. LIVE DRAFT | p:Maybe. | p:Yes.",
    conflicts: 0,
  },
  {
    row: "both sides moved different paragraphs",
    name: "stretch-move-reverse",
    base: "p:alpha beta | p:gamma delta | p:epsilon zeta",
    live: "p:alpha beta | p:epsilon zeta | p:gamma delta",
    draft: "p:alpha beta | p:epsilon zeta",
    merged: "p:alpha beta | p:epsilon zeta",
    conflicts: 1,
  },
  {
    row: "draft moves a paragraph, live removes it",
    name: "stretch-move-vs-delete",
    base: "p:alpha beta | p:gamma delta | p:epsilon zeta",
    live: "p:alpha beta | p:epsilon zeta",
    draft: "p:alpha beta | p:epsilon zeta | p:gamma delta",
    merged: "p:alpha beta | p:epsilon zeta | p:gamma delta",
    conflicts: 1,
  },
  {
    row: "both move one paragraph to different places",
    name: "stretch-both-move",
    base: "p#a:aa bb | p#c:cc dd | p#e:ee ff | p#g:gg hh",
    live: "p#c:cc dd | p#e:ee ff | p#a:aa bb | p#g:gg hh",
    draft: "p#c:cc dd | p#e:ee ff | p#g:gg hh | p#a:aa bb",
    merged: "p:cc dd | p:ee ff | p:gg hh | p:aa bb",
    conflicts: 1,
  },
  {
    row: "r1 B1: live rewrites a paragraph, the draft extends it",
    name: "id-rewrite-in-place",
    base: "p#m:Mara opened the door",
    live: "p#m:Rain fell on the roof",
    draft: "p#m:Mara opened the door tonight",
    merged: "p:Rain fell on the roof tonight",
    conflicts: 0,
  },
  {
    row: "r1 B1, sides exchanged",
    name: "id-rewrite-in-place-rev",
    base: "p#m:Mara opened the door",
    live: "p#m:Mara opened the door tonight",
    draft: "p#m:Rain fell on the roof",
    merged: "p:Rain fell on the roof tonight",
    conflicts: 0,
  },
  {
    row: "both rewrite one paragraph",
    name: "id-rewrite-in-place-both",
    base: "p#m:Mara opened the door",
    live: "p#m:Rain fell on the roof",
    draft: "p#m:Snow lay on the hill",
    merged: "p:Snow lay on the hill",
    conflicts: 2,
  },
  {
    row: "rewrite against an edit",
    name: "id-rewrite-vs-edit",
    base: "p:aa bb cc dd | p:zz",
    live: "p:qq rr ss tt | p:zz",
    draft: "p:aa bb cc DD | p:zz",
    merged: "p:aa bb cc DD | p:zz",
    conflicts: 1,
  },
  {
    row: "an edit against a rewrite",
    name: "id-edit-vs-rewrite",
    base: "p:aa bb cc dd | p:zz",
    live: "p:aa bb cc DD | p:zz",
    draft: "p:qq rr ss tt | p:zz",
    merged: "p:qq rr ss tt | p:zz",
    conflicts: 1,
  },
  {
    row: "a longer CJK sentence still merges",
    name: "cjk-long",
    base: "p:他慢慢地走进了房间，然后坐下。",
    live: "p:他慢慢地跑进了房间，然后坐下。",
    draft: "p:她慢慢地走进了房间，然后坐下。",
    merged: "p:她慢慢地跑进了房间，然后坐下。",
    conflicts: 0,
  },
  {
    row: "an echoed paragraph the draft added",
    name: "echo-paragraph",
    base: "p:one two | p:three four | p:five six",
    live: "p:one two | p:three FOUR | p:five six",
    draft: "p:one two three four | p:new alpha | p:new beta | p:three four | p:five six",
    merged: "p:one two three four | p:new alpha | p:new beta | p:three FOUR | p:five six",
    conflicts: 0,
  },
  {
    row: "three items, live edits two and the draft the third",
    name: "items-three",
    base: "list:Yes apple;Yes banana;Yes cherry",
    live: "list:Yes apple!;Yes banana!;Yes cherry",
    draft: "list:Yes apple;Yes banana;Yes cherry?",
    merged: "list:Yes apple!;Yes banana!;Yes cherry?",
    conflicts: 0,
  },
  {
    row: "empty items",
    name: "items-empty",
    base: "list:;;x",
    live: "list:;x",
    draft: "list:;y;x",
    merged: "list:;y;x",
    conflicts: 1,
  },
  {
    row: "an item live edited, an item the draft removed",
    name: "items-near-twin",
    base: "list:Yes apple;Yes banana.",
    live: "list:Yes banana!",
    draft: "list:No apple;Yes banana.",
    merged: "list:No apple;Yes banana!",
    conflicts: 1,
  },
  {
    row: "the same, with short items",
    name: "items-near-twin-short",
    base: "list:Yes.;Yes. banana",
    live: "list:Yes. banana!",
    draft: "list:No.;Yes. banana",
    merged: "list:No.;Yes. banana!",
    conflicts: 1,
  },
  {
    row: "the same, in a table",
    name: "rows-near-twin",
    base: "table:Ann,10;Bob,10",
    live: "table:Bob,*10*",
    draft: "table:Anne,10;Bob,10",
    merged: "table:Anne,10;Bob,10",
    conflicts: 1,
  },
  {
    row: "a shared prefix in every item",
    name: "items-shared-prefix",
    base: "list:same0 same1 same2 apple;same0 same1 same2 banana.",
    live: "list:same0 same1 same2 banana!",
    draft: "list:EDIT same1 same2 apple;same0 same1 same2 banana.",
    merged: "list:EDIT same1 same2 apple;same0 same1 same2 banana!",
    conflicts: 1,
  },
  {
    row: "live removes an item the draft edited",
    name: "items-remove-vs-edit",
    base: "list:apple pie;banana bread;cherry",
    live: "list:banana loaf;cherry",
    draft: "list:apple tart;banana bread;cherry",
    merged: "list:apple tart;banana loaf;cherry",
    conflicts: 1,
  },
  {
    row: "live removes a row the draft edited",
    name: "rows-remove-vs-edit",
    base: "table:Ann,10;Bob,20;Cat,30",
    live: "table:Bob,25;Cat,30",
    draft: "table:Anne,10;Bob,20;Cat,30",
    merged: "table:Anne,10;Bob,25;Cat,30",
    conflicts: 1,
  },
  {
    row: "an item joined onto another and edited",
    name: "items-glue",
    base: "list:w13;w14 w15 w16 w17",
    live: "list:w14 w15 w16 w17 w29",
    draft: "list:w32 w30 w13",
    merged: "list:w32 w30 w13",
    conflicts: 2,
  },
  {
    row: "near twins, both edited",
    name: "items-tie",
    base: "list:Yes apple#i1;Yes banana#i2",
    live: "list:Yes cherry#i2",
    draft: "list:No apple#i1;Yes banana#i2",
    merged: "list:No apple;Yes cherry",
    conflicts: 1,
  },
  {
    row: "a figure live replaced, the draft changed",
    name: "figure-vs-figure",
    base: "p:intro words here | fig:map | p:c d",
    live: "fig:map2 | p:c d",
    draft: "p:intro words here | fig:map3 | p:c d",
    merged: "fig:map3 | p:c d",
    conflicts: 1,
  },
  {
    row: "a paste filtered out, then a slide",
    name: "coords",
    base: "p:head b d | p:e e tail | p:f b",
    live: "p:head | p:e e e tail b d | p:f b",
    draft: "p:head EDIT d | p:d e e tail | p:f b",
    merged: "p:head EDIT d | p:e d e e tail | p:f b",
    conflicts: 2,
  },
  {
    row: "a paragraph moved out of a repeated pair, then a join",
    name: "moved-repeated-a",
    base: "p:a | p:b | p:c",
    live: "p:a b | p:c",
    draft: "p:a b | p:c | p:b",
    merged: "p:a b | p:c | p:b",
    conflicts: 0,
  },
  {
    row: "the same with a heading",
    name: "moved-repeated-h",
    base: "p:a | h1:b | p:c",
    live: "p:a b | p:c",
    draft: "p:a b | p:c | h1:b",
    merged: "p:a b | p:c | h1:b",
    conflicts: 0,
  },
  {
    row: "a repeated paragraph moved, another edited",
    name: "short-move",
    base: "p:Yes. | p:Yes. | p:other",
    live: "p:Yes. | p:other | p:Yes.",
    draft: "p:No. | p:Yes. | p:other",
    merged: "p:No. | p:other | p:Yes.",
    conflicts: 0,
  },
  // Scripts without spaces
  {
    row: "CJK run",
    name: "cjk-run",
    base: "p:他走了。",
    live: "p:他跑了。",
    draft: "p:她走了。",
    merged: "p:她跑了。",
    conflicts: 0,
  },
  // A short line does not link to a paragraph in another place
  {
    row: "a short line removed, an echo of it added far away",
    name: "short-line-far-addition",
    base: "p:No. | p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:The door stayed shut.",
    live: "p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:No, she said quietly. | p:The door stayed shut.",
    draft:
      "p:No! | p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:The door stayed shut.",
    merged:
      "p:No! | p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:No, she said quietly. | p:The door stayed shut.",
    conflicts: 1,
  },
  {
    row: "a short line removed, a far paragraph rewritten to hold it",
    name: "short-line-far-rewrite",
    base: "p:He nodded. | p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:The end came.",
    live: "p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:He nodded at her and the end came.",
    draft:
      "p:He nodded slowly. | p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:The end came.",
    merged:
      "p:He nodded slowly. | p:Rain fell on the old road. | p:The lamp burned low tonight. | p:Wind moved through the pines. | p:A dog barked far away. | p:He nodded at her and the end came.",
    conflicts: 1,
  },
  // A join inside a container is owned where it happens
  {
    row: "a list item joined into another while a move pairs it with a lookalike",
    name: "item-join-lookalike",
    base: "list:The rain fell on the road;He turned away",
    live: "list:She turned away LIVE;The rain fell on the road He turned away",
    draft: "list:The rain fell on the road;He turned;away",
    merged: "list:She turned away LIVE;The rain fell on the road;He turned;away",
    conflicts: 1,
  },
  {
    row: "the same with no shared vocabulary",
    name: "item-join-lookalike-abc",
    base: "list:a b c d e f;g h i",
    live: "list:x h i y;a b c d e f g h i",
    draft: "list:a b c d e f;g h;i",
    merged: "list:x h i y;a b c d e f;g h;i",
    conflicts: 1,
  },
  {
    row: "the same with table rows",
    name: "row-join-lookalike",
    base: "table:a b c d e f;g h i",
    live: "table:x h i y;a b c d e f g h i",
    draft: "table:a b c d e f;g h;i",
    merged: "table:x h i y;a b c d e f;g h;i",
    conflicts: 1,
  },
  // Equal blocks in a stretch are no clash only when they sit in the same places
  {
    row: "both sides split a block; the draft's second half sits past another paragraph",
    name: "split-placed-apart",
    base: "p:a b | p:c d",
    live: "p:a | p:b | p:c d",
    draft: "p:a | p:c d | p:b",
    merged: "p:a | p: | p:c d | p:b",
    conflicts: 0,
  },
  {
    row: "the same inside a quote",
    name: "split-placed-apart-quote",
    base: "quote:a b;c d",
    live: "quote:a;b;c d",
    draft: "quote:a;c d;b",
    merged: "quote:a;;c d;b",
    conflicts: 0,
  },
  // block-attributes-merged: each attribute from the side that changed it (flat-model/design.md section 5)
  {
    row: "live indents an item, the draft checks it",
    name: "attrs-different-attributes",
    base: "p#a{path=-,marker=item}:one two | p#b:three",
    live: "p#a{path=--,marker=item}:one two | p#b:three",
    draft: "p#a{path=-,marker=done}:one two | p#b:three",
    merged: "p{path=--,marker=done}:one two | p:three",
    conflicts: 0,
  },
  {
    row: "both sides change the same attribute to different values",
    name: "attrs-same-attribute-clash",
    base: "p#a{path=-,marker=item}:one two",
    live: "p#a{path=--,marker=item}:one two",
    draft: "p#a{path=---,marker=item}:one two",
    merged: "p{path=---,marker=item}:one two",
    conflicts: 1,
  },
  {
    row: "both sides change the same attribute to the same value",
    name: "attrs-same-attribute-agree",
    base: "p#a{path=-,marker=item}:one two",
    live: "p#a{path=-,marker=done}:one two",
    draft: "p#a{path=-,marker=done}:one two",
    merged: "p{path=-,marker=done}:one two",
    conflicts: 0,
  },
  {
    row: "live changes an attribute, the draft edits the text and another attribute",
    name: "attrs-against-text-edit",
    base: "p#a{path=-,marker=item}:one two three",
    live: "p#a{path=--,marker=item}:one two three",
    draft: "p#a{path=-,marker=done}:one two THREE",
    merged: "p{path=--,marker=done}:one two THREE",
    conflicts: 0,
  },
  {
    row: "live changes an attribute and inserts a block before it, the draft changes another attribute",
    name: "attrs-beside-inserted-block",
    base: "p#a{path=-,marker=item}:one two | p#b:three",
    live: "p#x:fresh | p#a{path=--,marker=item}:one two | p#b:three",
    draft: "p#a{path=-,marker=done}:one two | p#b:three",
    merged: "p:fresh | p{path=--,marker=done}:one two | p:three",
    conflicts: 0,
  },
  {
    row: "live changes an attribute of a block the draft removed",
    name: "attrs-against-removal",
    base: "p#a{path=-,marker=item}:one two | p#b:three",
    live: "p#a{path=--,marker=item}:one two | p#b:three",
    draft: "p#b:three",
    merged: "p:three",
    conflicts: 1,
  },
];
