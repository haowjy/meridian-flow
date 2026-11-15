import { writeFileSync } from "node:fs";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME, withBlockIds } from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { it } from "vitest";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { createAgentEditCodecFactory } from "../codec-adapter.js";
import { wordDiff } from "../diff/tokens.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { type ResolveWriteParams, resolveWrite } from "./resolve.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);
const WORDS = "the rain had been working at shutter since before dawn and lin feng opened his eyes to smell of burnt incense sandalwood something older under it straw mat back was damp where last night got through roof".split(" ");
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const para = (n: number, tag: string) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)] + (i % 13 === 12 ? "." : ""));
  out[Math.floor(n / 2)] = `mark${tag}`;
  return out.join(" ");
};
function build(paras: string[]) {
  const doc = new Y.Doc({ gc: false });
  prosemirrorToYXmlFragment(schema.node("doc", null, codec.parse(paras.join("\n\n")).blocks.map((b) => withBlockIds(b))), doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return Y.encodeStateAsUpdate(doc);
}
function time(state: Uint8Array, write: object, mode: boolean, n: number) {
  if (mode) process.env.WINDOW_DIFF = "1"; else delete process.env.WINDOW_DIFF;
  const resolveMs: number[] = [];
  const applyMs: number[] = [];
  let bytes = 0;
  for (let i = 0; i < n + 3; i++) {
    const view = new Y.Doc({ gc: false });
    Y.applyUpdate(view, state);
    const seen = Y.encodeStateVector(view);
    const t0 = performance.now();
    const resolved = resolveWrite({ doc: view, model, codec, links: "preassigned" }, { documentAddress: { documentId: "123e4567-e89b-12d3-a456-426614174000", filePath: "c.md" }, ...write } as ResolveWriteParams);
    const t1 = performance.now();
    if (!resolved.ok) throw new Error(resolved.error.message);
    applyEdits(view, model, resolved.edits, { type: "agent", actorTurnId: "turn-1" });
    const t2 = performance.now();
    bytes = Y.encodeStateAsUpdate(view, seen).length;
    if (i >= 3) { resolveMs.push(t1 - t0); applyMs.push(t2 - t1); }
  }
  delete process.env.WINDOW_DIFF;
  const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { resolve: med(resolveMs), apply: med(applyMs), bytes };
}

it("bench", () => {
  const lines: string[] = [];
  const docs: Record<string, string[]> = {
    "chapter: 60 paragraphs x 120 words": Array.from({ length: 60 }, (_, i) => para(120, `${i}x`)),
    "long: 300 paragraphs x 120 words": Array.from({ length: 300 }, (_, i) => para(120, `${i}x`)),
    "one 2,000-word paragraph in 60": [...Array.from({ length: 59 }, (_, i) => para(120, `${i}x`)), para(2000, "bigx")],
  };
  for (const [name, paras] of Object.entries(docs)) {
    const state = build(paras);
    const target = paras[paras.length - 1];
    const words = target.split(" ");
    const mid = Math.floor(words.length / 2);
    const swap = (text: string) => text.replace(/mark\w+/, "CHANGED");
    const sentence = words.slice(mid - 10, mid + 10).join(" ");
    const scattered = words.map((w, i) => (i % 9 === 4 ? `${w}ly` : w)).join(" ");
    const writes: Record<string, object> = {
      "2-word window, 1 changed": { command: "replace", find: words.slice(mid - 1, mid + 1).join(" "), content: swap(words.slice(mid - 1, mid + 1).join(" ")) },
      "20-word window, 1 changed": { command: "replace", find: sentence, content: swap(sentence) },
      "whole paragraph, 1 word changed": { command: "replace", find: target, content: swap(target) },
      "whole paragraph, every 9th word changed": { command: "replace", find: target, content: scattered },
      "whole paragraph, all new words": { command: "replace", find: target, content: words.map((w) => `${w}q`).join(" ") },
    };
    lines.push(`# ${name} (target paragraph ${words.length} words)`);
    for (const [label, write] of Object.entries(writes)) {
      const a = time(state, write, false, 15);
      const b = time(state, write, true, 15);
      lines.push(`${label} | today resolve ${a.resolve.toFixed(2)}ms apply ${a.apply.toFixed(2)}ms update ${a.bytes}B | window diff resolve ${b.resolve.toFixed(2)}ms apply ${b.apply.toFixed(2)}ms update ${b.bytes}B`);
    }
    // the diff alone
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) wordDiff(target, scattered);
    lines.push(`wordDiff alone on the target paragraph, every 9th word changed: ${((performance.now() - t0) / 200).toFixed(3)}ms`);
  }
  // worst case: no shared words, large
  for (const n of [120, 2000, 10000]) {
    const a = para(n, "a"); const b = a.split(" ").map((w) => `${w}q`).join(" ");
    const c = a.split(" ").map((w, i) => (i % 2 ? `${w}q` : w)).join(" ");
    let t0 = performance.now(); for (let i = 0; i < 20; i++) wordDiff(a, b); const d1 = (performance.now() - t0) / 20;
    t0 = performance.now(); for (let i = 0; i < 20; i++) wordDiff(a, c); const d2 = (performance.now() - t0) / 20;
    lines.push(`wordDiff ${n} words: all changed ${d1.toFixed(3)}ms, every other changed ${d2.toFixed(3)}ms`);
  }
  writeFileSync("/tmp/p17768/bench.txt", lines.join("\n"));
}, 600000);
