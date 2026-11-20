// @vitest-environment jsdom
/**
 * Probe: the manuscript gate of the single-truth design. How does an Undo of an AI edit, read from
 * content, come out when the manuscript is written through the real paths? The AI writes through
 * the model's tools (`core.write`, the lowering of a find and a replacement into Yjs operations);
 * the writer types in a real TipTap editor bound by y-tiptap, relayed to the room as the app relays
 * it. Each row is played in two fresh worlds from one script: the content Undo, and the oracle (the
 * same later typing without the AI's edit). See manuscript-gate.md beside this file.
 */
import {
  changeStateIn,
  type EditChange,
  editChanges,
  takeOut,
} from "@meridian/agent-edit/content-merge";
import {
  blocksEqual,
  readBlocks,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "prosemirror-model";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import { DocumentHistory } from "@/core/editor/editor-history";
import { createLocalPresence } from "@/core/editor/local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";

const ROWS = Number(process.env.GATE_ROWS ?? 60);
const FILE = "ch.md";
const CTX = { sessionId: "s", threadId: "t" };
const schema = buildDocumentSchema();

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

// --- random text -----------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;
const ADJ = ["old", "cold", "quiet", "broken", "narrow", "pale", "heavy", "bright", "small", "tired"];
const NOUN = ["door", "river", "lantern", "soldier", "road", "garden", "letter", "window", "blade", "child", "wind", "tower"];
const VERB = ["waited", "turned", "fell", "opened", "burned", "listened", "crossed", "watched", "moved", "slept"];
const PREP = ["by", "under", "behind", "near", "beyond", "against"];
const ADV = ["slowly", "again", "at last", "without a word", "in silence"];
const VOCAB = new Set([
  ...ADJ,
  ...NOUN,
  ...VERB,
  ...PREP,
  ..."the The and then And She He she he said at last without a word in silence a b map".split(" "),
  ...ADV.flatMap((a) => a.split(" ")),
]);
/** A sentence as words, the last carrying the full stop. Quotes and commas stay on their words. */
const sentence = (r: R): string[] => {
  const shape = r.int(4);
  const np = () => `the ${r.pick(ADJ)} ${r.pick(NOUN)}`;
  const s =
    shape === 0
      ? `The ${r.pick(ADJ)} ${r.pick(NOUN)} ${r.pick(VERB)} ${r.pick(PREP)} ${np()}.`
      : shape === 1
        ? `${r.pick(["She", "He"])} ${r.pick(VERB)} ${r.pick(ADV)}, and ${np()} ${r.pick(VERB)}.`
        : shape === 2
          ? `And then ${np()} ${r.pick(VERB)}!`
          : `"The ${r.pick(NOUN)}," ${r.pick(["she", "he"])} said, "${r.pick(VERB)} ${r.pick(PREP)} ${np()}."`;
  return s.split(" ");
};
const likeWord = (r: R, like: string): string => {
  const punct = /[^A-Za-z]+$/.exec(like)?.[0] ?? "";
  const lead = /^[^A-Za-z]+/.exec(like)?.[0] ?? "";
  return `${lead}${r.pick([...ADJ, ...NOUN, ...VERB])}${punct}`;
};

// --- the document under test ----------------------------------------------------------------

type Family = "plain" | "marks" | "table" | "image";
function seedMarkdown(r: R, family: Family): string {
  const paras = Array.from({ length: 3 + r.int(2) }, () =>
    Array.from({ length: 2 + r.int(3) }, () => sentence(r)),
  );
  const texts = paras.map((p) => p.map((s) => s.join(" ")));
  if (family === "marks") {
    // Two words of one sentence are bold, whole words so no mark edge sits inside a word.
    const i = r.int(texts.length);
    const sents = paras[i] as string[][];
    const si = r.int(sents.length);
    const s = [...(sents[si] as string[])];
    const at = r.int(Math.max(1, s.length - 1));
    if (s.length > at + 1 && /^[A-Za-z]+$/.test(s[at] as string) && /^[A-Za-z]+$/.test(s[at + 1] as string))
      s.splice(at, 2, `**${s[at]} ${s[at + 1]}**`);
    (texts[i] as string[])[si] = s.join(" ");
  }
  if (family === "image") {
    const i = r.int(texts.length);
    const parts = texts[i] as string[];
    const at = 1 + r.int(Math.max(1, parts.length - 1));
    parts.splice(at, 0, "![map](assets/a.png)");
  }
  const blocks = texts.map((t) => t.join(" "));
  if (family === "table") {
    const cell = () => sentence(r).join(" ");
    blocks.push(`| a | b |\n| - | - |\n| ${cell()} | ${cell()} |`);
  }
  return blocks.join("\n\n");
}

/** The text a writer reads, one line per text block (table cells and paragraphs alike), and what marks and images stand where. */
function textblocks(blocks: readonly PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const b of blocks) {
    if (b.isTextblock) out.push(b);
    else
      b.descendants((n) => {
        if (n.isTextblock) out.push(n);
        return !n.isTextblock;
      });
  }
  return out;
}
const textOf = (blocks: readonly PMNode[]) =>
  textblocks(blocks)
    .map((b) => b.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
const boldOf = (blocks: readonly PMNode[]) => {
  const out: string[] = [];
  for (const b of textblocks(blocks))
    b.forEach((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === "strong")) out.push((n.text ?? "").trim());
    });
  return out.join("|");
};
const imagesOf = (blocks: readonly PMNode[]) => {
  let n = 0;
  for (const b of blocks) b.descendants((x) => void (x.type.name === "image" && n++));
  return n;
};
/** What an oracle comparison looks at: words, bold runs, images. Spaces differ with how an edit leaves them. */
const sig = (blocks: readonly PMNode[]) =>
  `${textOf(blocks).replace(/[ \t]+/g, "")}#${boldOf(blocks).replace(/[ \t]+/g, "")}#${imagesOf(blocks)}`;
/** Words as a reader sees them: runs between spaces, less the quotes and stops round them. `garden.zq1` is one word, and glued. */
const wordsIn = (text: string) =>
  text
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);

// --- one world: a room, the model's tools and a real editor -----------------------------------

type Part = { before: PMNode[]; after: PMNode[] };
type Cmd = Record<string, unknown> & { command: string };

class World {
  readonly ctx;
  readonly live: Y.Doc;
  readonly doc: Y.Doc;
  readonly editor: Editor;
  readonly toLive: Uint8Array[] = [];
  readonly toEditor: Uint8Array[] = [];
  held = false;
  constructor(markdown: string, seed: number) {
    // Client ids and block ids come from the seed, so a world replays.
    const ids = rng(seed + 1_000_003);
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(ids.next() * 256);
      return array;
    });
    this.ctx = createWriteToolHarness({ [FILE]: markdown });
    this.live = this.ctx.liveDoc(FILE);
    this.doc = new Y.Doc({ gc: false });
    this.doc.clientID = 4_000_000 + (seed % 1000);
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.live));
    this.editor = new Editor({
      element: document.createElement("div"),
      ...createEditorConfig({
        document: this.doc,
        history: DocumentHistory.forDocument(this.doc),
        presence: createLocalPresence(new Awareness(this.doc)),
        showCollaborationDecorations: false,
      }),
    });
    editors.push(this.editor);
    // A star as in the app: the editor talks to the room only.
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "net") this.toLive.push(u);
    });
    this.live.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "editor") this.toEditor.push(u);
    });
    // Opening the document in an editor gives its blocks their ids, as in the app.
    this.editor.view.dispatch(this.editor.state.tr.setMeta("gate", "open"));
    this.editor.view.dispatch(this.editor.state.tr.insertText(" ", 1).delete(1, 2));
    this.sync();
  }
  /** Deliver everything not held back, both ways, until quiet. */
  sync() {
    for (let guard = 0; guard < 20; guard++) {
      const up = this.held ? [] : this.toLive.splice(0);
      const down = this.toEditor.splice(0);
      if (!up.length && !down.length) return;
      for (const u of up) Y.applyUpdate(this.live, u, "editor");
      for (const u of down) Y.applyUpdate(this.doc, u, "net");
    }
  }
  liveBlocks(): PMNode[] {
    return readBlocks(this.live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  }
  editorBlocks(): PMNode[] {
    return readBlocks(this.doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  }
  editorText(): string {
    return textOf(this.editorBlocks());
  }
  /** One tool call of the AI, with the blocks it changed. */
  async ai(cmd: Cmd): Promise<Part | null> {
    await this.ctx.core.read({ file: FILE }, CTX);
    const before = this.liveBlocks();
    const updates: Uint8Array[] = [];
    const collect = (u: Uint8Array) => updates.push(u);
    this.live.on("update", collect);
    let status: string;
    try {
      status = ((await this.ctx.core.write({ ...cmd, file: FILE } as never, CTX)) as { result: { status: string } }).result.status;
    } finally {
      this.live.off("update", collect);
    }
    if (status !== "success" || !updates.length) return null;
    this.sync();
    const after = this.liveBlocks();
    if (blocksEqual(before, after)) return null;
    return { before, after };
  }
  async bodies(): Promise<{ hash: string; body: string }[]> {
    const read = (await this.ctx.core.read({ file: FILE }, CTX)) as {
      result: { blocks: { items: { hash: string; body: string }[] }[] };
    };
    return read.result.blocks.flatMap((b) => b.items);
  }
}

// --- the script: what the AI and the writer do, found by the words they touch ----------------

type AiSpec =
  | { k: "rw"; sent: string; at: number; n: number; next: string[] }
  | { k: "rs"; sent: string; next: string[] }
  | { k: "ds"; sent: string }
  | { k: "is"; sent: string; next: string[] }
  | { k: "ap"; sent: string; next: string[] };
type WriterSpec =
  | { k: "rw"; sent: string; at: number; token: string }
  | { k: "iw"; sent: string; at: number; token: string }
  | { k: "dw"; sent: string; at: number }
  | { k: "is"; sent: string; next: string[] }
  | { k: "bold"; sent: string; at: number };
type Step =
  | { who: "ai"; specs: AiSpec[]; target?: true }
  | { who: "writer"; spec: WriterSpec; unsent?: true }
  | { who: "skip" };

const sentencesOfText = (blocks: readonly PMNode[]): string[][] =>
  textblocks(blocks).map((b) => b.textContent.replace(/\s+/g, " ").trim().split(/(?<=[.!?]["”]?) /).filter(Boolean));
const allSentences = (blocks: readonly PMNode[]) => sentencesOfText(blocks).flat();
const unique = <T>(xs: T[], x: T) => xs.filter((y) => y === x).length === 1;

function genAi(r: R, blocks: readonly PMNode[], aim: string[] | null, allowAdd: boolean): AiSpec[] {
  const sents = allSentences(blocks);
  const out: AiSpec[] = [];
  const used = new Set<string>();
  const n = 1 + r.int(2);
  for (let i = 0; i < n; i++) {
    const pool = aim?.length && r.chance(0.6) ? aim.filter((s) => sents.includes(s)) : sents;
    if (!pool.length) continue;
    const sent = r.pick(pool);
    if (used.has(sent) || !unique(sents, sent)) continue;
    used.add(sent);
    const words = sent.split(" ");
    const k = r.pick(["rw", "rw", "rw", "rs", "rs", "ds", "is", ...(allowAdd ? (["ap"] as const) : [])] as const);
    if (k === "rw") {
      const at = r.int(words.length);
      const len = Math.min(1 + r.int(2), words.length - at);
      out.push({ k, sent, at, n: len, next: words.slice(at, at + len).map((w) => likeWord(r, w)) });
    } else if (k === "ds") out.push({ k, sent });
    else out.push({ k, sent, next: sentence(r) });
  }
  return out;
}

/** The tool calls of a spec, against the markdown the model just read. `null`: it cannot be said unambiguously. */
function commandOf(spec: AiSpec, bodies: { hash: string; body: string }[]): Cmd | null {
  const text = bodies.map((b) => b.body).join("\n");
  const count = (needle: string) => text.split(needle).length - 1;
  const words = spec.sent.split(" ");
  switch (spec.k) {
    case "rw": {
      // The changed words with one neighbour each side, so the phrase is unlikely to occur twice.
      const from = Math.max(0, spec.at - 1);
      const to = Math.min(words.length, spec.at + spec.n + 1);
      const find = words.slice(from, to).join(" ");
      if (count(find) !== 1) return null;
      const next = [...words.slice(from, spec.at), ...spec.next, ...words.slice(spec.at + spec.n, to)];
      return { command: "replace", find, content: next.join(" ") };
    }
    case "rs":
      return count(spec.sent) === 1 ? { command: "replace", find: spec.sent, content: spec.next.join(" ") } : null;
    case "ds":
      return count(spec.sent) === 1 ? { command: "replace", find: spec.sent, content: "" } : null;
    case "is":
      return count(spec.sent) === 1 ? { command: "insert", find: spec.sent, content: ` ${spec.next.join(" ")}` } : null;
    case "ap": {
      const at = bodies.find((b) => b.body.includes(spec.sent) && !b.body.startsWith("<"));
      return at && count(spec.sent) === 1 ? { command: "insert", after: at.hash, content: spec.next.join(" ") } : null;
    }
  }
}

let typedCounter = 0;
const typedToken = () => `zq${typedCounter++}`;
function genWriter(r: R, blocks: readonly PMNode[], aim: string[] | null, unsent: boolean): WriterSpec | null {
  const sents = allSentences(blocks);
  const pool = aim?.length && (unsent || r.chance(0.35)) ? aim.filter((s) => sents.includes(s)) : sents;
  if (!pool.length) return null;
  const sent = r.pick(pool);
  if (!unique(sents, sent)) return null;
  const words = sent.split(" ");
  const at = r.int(words.length);
  // Typed words are unique tokens, so a lost one can be told from a reworded one.
  const k = unsent ? r.pick(["iw", "iw", "rw"] as const) : r.pick(["rw", "iw", "iw", "dw", "is", "bold"] as const);
  const own = (w: string | undefined) => !w || w.startsWith("zq");
  if (k === "iw") return { k, sent, at, token: typedToken() };
  if (own(words[at])) return null;
  if (k === "rw") return { k, sent, at, token: typedToken() };
  if (k === "dw") return words.length > 2 ? { k, sent, at } : null;
  if (k === "bold") return /^[A-Za-z]+$/.test(words[at] as string) ? { k, sent, at } : null;
  return { k: "is", sent, next: sentence(r).map((w, i) => (i === 1 ? typedToken() : w)) };
}

/** The editor position of a character offset in a text block's text, skipping inline atoms (an image has no text). */
function typePos(editor: Editor, sent: string): { from: number; words: { from: number; to: number }[]; end: number } | null {
  let found: { from: number; words: { from: number; to: number }[]; end: number } | null = null;
  let hits = 0;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textContent;
    const idx = text.indexOf(sent);
    if (idx < 0) return false;
    hits++;
    // Map text offsets to positions, child by child.
    const map: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) for (let i = 0; i < (child.text ?? "").length; i++) map.push(pos + 1 + offset + i);
    });
    const words: { from: number; to: number }[] = [];
    let at = idx;
    for (const w of sent.split(" ")) {
      words.push({ from: map[at] as number, to: (map[at + w.length - 1] as number) + 1 });
      at += w.length + 1;
    }
    found = { from: map[idx] as number, words, end: (map[idx + sent.length - 1] as number) + 1 };
    return false;
  });
  return hits === 1 ? found : null;
}

/** The writer's typing, through the editor's view as the keyboard drives it. Returns the words typed. */
function type(world: World, spec: WriterSpec): string[] | null {
  const at = typePos(world.editor, spec.sent);
  if (!at) return null;
  const { view, state } = world.editor;
  const w = at.words[spec.k === "is" ? 0 : spec.at];
  if (!w) return null;
  switch (spec.k) {
    case "rw": {
      const punct = /[^A-Za-z]+$/.exec(spec.sent.split(" ")[spec.at] ?? "")?.[0] ?? "";
      view.dispatch(state.tr.insertText(`${spec.token}${punct}`, w.from, w.to));
      return [spec.token];
    }
    case "iw":
      view.dispatch(state.tr.insertText(`${spec.token} `, w.from));
      return [spec.token];
    case "dw":
      view.dispatch(state.tr.delete(w.from, Math.min(w.to + 1, at.end)));
      return [];
    case "bold":
      view.dispatch(state.tr.addMark(w.from, w.to, state.schema.marks.strong!.create()));
      return [];
    case "is":
      view.dispatch(state.tr.insertText(` ${spec.next.join(" ")}`, at.end));
      return spec.next.filter((w) => w.startsWith("zq"));
  }
}

// --- the Undos -------------------------------------------------------------------------------

/** Whether the change stands in the text, by the server's own read (`content-merge/stands.ts`), and the text without it. */
function contentUndo(change: EditChange, text: readonly PMNode[]): { stands: boolean; text: PMNode[] } {
  if (changeStateIn(schema, change, text) !== "stands") return { stands: false, text: [...text] };
  return { stands: true, text: takeOut(schema, change, text) };
}

type Mode = "content" | "oracle";
type Outcome = {
  failed: string | null;
  text: PMNode[];
  /** The writer's view (the editor) the moment before the Undo. */
  seen: string;
  /** The room's blocks the moment before the Undo, with the unsent typing not yet in. */
  seenBlocks: PMNode[];
  offered: boolean;
  allOffered: boolean;
  diverged: boolean;
  typed: string[];
};

/** Play the script in a fresh world. With no script yet, the steps are generated and appended to it. */
async function play(seed: number, family: Family, mode: Mode, script: Step[], unsent: boolean): Promise<Outcome> {
  try {
    return await playRow(seed, family, mode, script, unsent);
  } finally {
    for (const e of editors.splice(0)) if (!e.isDestroyed) e.destroy();
    vi.restoreAllMocks();
  }
}
async function playRow(seed: number, family: Family, mode: Mode, script: Step[], unsent: boolean): Promise<Outcome> {
  const r = rng(seed);
  const markdown = seedMarkdown(r, family);
  const world = new World(markdown, seed);
  const gen = script.length === 0;
  const typed: string[] = [];
  const fail = (why: string): Outcome => ({ failed: why, text: [], seen: "", seenBlocks: [], offered: false, allOffered: false, diverged: false, typed });
  const targetParts: Part[] = [];
  const parts: Part[] = [];
  let aim: string[] | null = null;
  const rows = 1 + 1 + r.int(3);
  for (let i = 0; i < rows; i++) {
    const last = i === rows - 1;
    let step = script[i];
    if (!step) {
      if (i === 0) step = { who: "ai", specs: genAi(r, world.liveBlocks(), null, family !== "table"), target: true };
      else if (last && unsent) {
        const w = genWriter(r, world.editorBlocks(), aim, true);
        if (!w) return fail("no unsent op");
        step = { who: "writer", spec: w, unsent: true };
      } else if (r.chance(0.7)) {
        const w = genWriter(r, world.editorBlocks(), aim, false);
        step = w ? { who: "writer", spec: w } : { who: "skip" };
      } else step = { who: "ai", specs: genAi(r, world.liveBlocks(), aim, family !== "table") };
      script[i] = step;
    }
    if (step.who === "skip") continue;
    if (step.who === "ai") {
      if (step.target && mode === "oracle") continue;
      const before = world.liveBlocks();
      let any = false;
      for (const spec of step.specs) {
        const cmd = commandOf(spec, await world.bodies());
        if (!cmd) return gen ? fail("ambiguous ai command") : fail("replay: ai command");
        const part = await world.ai(cmd);
        if (!part) return fail("ai write refused or unchanged");
        any = true;
        parts.push(part);
        if (step.target) targetParts.push(part);
      }
      if (!any) return fail("empty ai step");
      if (step.target) {
        const was = new Set(allSentences(before));
        aim = allSentences(world.liveBlocks()).filter((s) => !was.has(s));
        if (!aim.length) return fail("target changed no sentence");
      }
    } else {
      world.held = Boolean(step.unsent);
      const t = type(world, step.spec);
      if (!t) return gen ? fail("writer anchor missing") : mode === "oracle" ? fail("dependent") : fail("replay: writer");
      typed.push(...t);
      world.sync();
    }
  }
  const seen = world.editorText();
  const seenBlocks = world.liveBlocks();
  let offered = false;
  let allOffered = false;
  if (mode === "content") {
    let text = world.liveBlocks();
    const states: boolean[] = [];
    for (const p of [...targetParts].reverse())
      for (const c of editChanges(schema, { before: p.before, after: p.after })) {
        const u = contentUndo(c, text);
        states.push(u.stands);
        if (u.stands) text = u.text;
      }
    offered = states.some(Boolean);
    allOffered = states.length > 0 && states.every(Boolean);
    if (offered) {
      world.live.clientID = 9_000_000;
      world.live.transact(() => writeBlocks(world.live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, text), "server");
    }
  }
  // The unsent typing reaches the room after the Undo; then everything settles.
  world.held = false;
  world.sync();
  const live = world.liveBlocks();
  const diverged = textOf(live) !== world.editorText();
  const out = { failed: null, text: live, seen, seenBlocks, offered, allOffered, diverged, typed };
  return out;
}

// --- the run ---------------------------------------------------------------------------------

type Tally = Record<string, number>;
const bump = (t: Tally, k: string, by = 1) => void (t[k] = (t[k] ?? 0) + by);

it(`manuscript gate: ${ROWS} rows per kind`, async () => {
  const kinds: { family: Family; unsent: boolean }[] = [];
  for (const family of ["plain", "marks", "table", "image"] as const)
    for (const unsent of [false, true]) kinds.push({ family, unsent });
  const total: Record<string, Tally> = {};
  const refused: Tally = {};
  const samples: Record<string, unknown[]> = {};
  for (const { family, unsent } of kinds) {
    const name = `${family}${unsent ? "/unsent" : "/synced"}`;
    const t: Tally = (total[name] = {});
    let produced = 0;
    for (let seed = 1; produced < ROWS && seed < ROWS * 6; seed++) {
      const script: Step[] = [];
      const base = seed * 7 + (family === "plain" ? 1 : family === "marks" ? 2 : family === "table" ? 3 : 4) + (unsent ? 100_000 : 0);
      let content: Outcome;
      let oracle: Outcome;
      try {
        content = await play(base, family, "content", script, unsent);
        if (content.failed) {
          bump(refused, `${name}: ${content.failed}`);
          continue;
        }
        oracle = await play(base, family, "oracle", script, unsent);
      } catch (error) {
        bump(refused, `${name}: THROW ${(error as Error).message.slice(0, 60)}`);
        continue;
      }
      produced++;
      const independent = !oracle.failed;
      const allowed = new Set([...VOCAB, ...content.typed]);
      const gluedWords = wordsIn(textOf(content.text)).filter((w) => !allowed.has(w));
      // A typed word is lost when its letters are gone from the text; one glued to a neighbour is not lost, and counts as glued.
      const present = (text: string, tok: string) => new RegExp(`${tok}(?!\\d)`).test(text);
      const lost = content.typed.filter((tok) => present(content.seen, tok) && !present(textOf(content.text), tok));
      bump(t, "rows");
      const result = sig(content.text) === sig(oracle.text) ? "matches oracle" : sig(content.text) === sig(content.seenBlocks) ? "left as it was" : "other text";
      if (independent) {
        bump(t, "independent rows");
        bump(t, `content ${result}`);
      }
      if (gluedWords.length) bump(t, "content glued word rows");
      bump(t, "content glued words", gluedWords.length);
      bump(t, "content lost words", lost.length);
      if (lost.length) bump(t, "content lost-word rows");
      if (content.offered) bump(t, "content Undo offered");
      if (content.allOffered) bump(t, "content Undo offered for every change");
      if (content.diverged) bump(t, "diverged (editor differs from room)");
      const bad: string[] = [];
      if (gluedWords.length) bad.push("glue");
      if (lost.length) bad.push("lost");
      if (independent && result === "other text") bad.push("other text");
      for (const b of bad) {
        const list = (samples[`${name}: ${b}`] ??= []);
        if (list.length < 3)
          list.push({ seed: base, script: JSON.stringify(script), seen: content.seen, content: textOf(content.text), oracle: independent ? textOf(oracle.text) : null });
      }
    }
  }
  const sum = (key: string) => Object.values(total).reduce((n, t) => n + (t[key] ?? 0), 0);
  const keys = [...new Set(Object.values(total).flatMap((t) => Object.keys(t)))];
  const order = ["rows", "independent rows", "content matches oracle", "content left as it was", "content other text", "content glued word rows", "content glued words", "content lost-word rows", "content lost words", "content Undo offered", "content Undo offered for every change", "diverged (editor differs from room)"];
  const lines = [`| kind | ${order.join(" | ")} |`, `|---|${order.map(() => "---:").join("|")}|`];
  for (const [name, t] of Object.entries(total)) lines.push(`| ${name} | ${order.map((k) => t[k] ?? 0).join(" | ")} |`);
  lines.push(`| **all** | ${order.map((k) => sum(k)).join(" | ")} |`);
  process.stdout.write(
    `\n${JSON.stringify({ rowsPerKind: ROWS, unlisted: keys.filter((k) => !order.includes(k)) })}\n${lines.join("\n")}\nrows not produced:\n${JSON.stringify(refused, null, 1)}\nsamples:\n${JSON.stringify(samples, null, 1)}\n`,
  );
  expect(true).toBe(true);
}, 3_600_000);
