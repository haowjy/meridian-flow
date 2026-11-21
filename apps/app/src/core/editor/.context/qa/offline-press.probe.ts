// @vitest-environment jsdom
/**
 * Probe: a tab types and deletes offline in one view of a paragraph holding up to three drafts'
 * suggestions, while another client Applies or Discards one draft; then the tab reconnects. Every
 * character keeps each mark as one side left it (both sides' changes stand), and no mark of a
 * resolved change survives. Run it by hand: see offline-press.md beside this file.
 */
import { dropResolvedMarks, pressStored } from "@meridian/agent-edit";
import { suggestRewrite } from "@meridian/agent-edit/test-support";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { View } from "@meridian/suggestions";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import { DocumentHistory } from "@/core/editor/editor-history";
import { createLocalPresence } from "@/core/editor/local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";

const seed0 = Number(process.env.FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
const runs = Number(process.env.FUZZ_RUNS ?? 300);
const DEBUG = process.env.FUZZ_DEBUG === "1";

let rng = 0;
/** A deterministic integer in [0, n) (mulberry32, as the other probes), so a seed replays the run. */
const rnd = (n: number) => {
  rng = (rng + 0x6d2b79f5) >>> 0;
  let t = rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
};

const schema = buildDocumentSchema();
const DRAFTS = ["draftaaaaaaa", "draftbbbbbbb", "draftccccccc"];
const WORDS = "rose woke before dawn while rain battered the shutters ruined hall".split(" ");
const START = [
  "Lin Feng opened his eyes to the smell of burnt incense.",
  "The courtyard was quiet and the bells had not yet rung.",
];

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

/** A tab: an editor on its own Y.Doc, which sweeps what it receives as `DocumentSession` does. */
function tab(clientID: number, view: View) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (!tr.local) dropResolvedMarks(doc, tr);
  });
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
  editor.commands.setSuggestionView(view, view.draft ? { chat: null, turn: null, by: "user:u" } : null);
  return { doc, editor };
}

/** The writer types at a random caret, or deletes a few characters after it, in the tab's view. */
function writerEdit(e: Editor) {
  const at = 1 + rnd(e.state.doc.content.size - 2);
  e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(at))));
  if (rnd(3) > 0) {
    for (const ch of ` w${rnd(100)}`) e.view.dispatch(e.state.tr.insertText(ch));
    return;
  }
  const from = e.state.selection.from;
  const to = Math.min(from + 1 + rnd(6), e.state.doc.resolve(from).end());
  if (to > from) e.view.dispatch(e.state.tr.delete(from, to));
}

/** Each live character's attributes, by Yjs id, as the text's format items leave them. */
function charAttrs(doc: Y.Doc): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const node of doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).createTreeWalker(() => true)) {
    if (!(node instanceof Y.XmlText)) continue;
    const attrs: Record<string, string> = {};
    for (let n = node._start; n; n = n.right) {
      if (n.deleted) continue;
      if (n.content instanceof Y.ContentFormat) {
        if (n.content.value === null) delete attrs[n.content.key];
        else attrs[n.content.key] = JSON.stringify(n.content.value);
      } else if (n.content instanceof Y.ContentString) {
        for (let i = 0; i < n.length; i++) out.set(`${n.id.client}:${n.id.clock + i}`, { ...attrs });
      }
    }
  }
  return out;
}

/** The items of each text, for reading one failing seed (`FUZZ_DEBUG=1`). */
function dump(label: string, doc: Y.Doc) {
  if (!DEBUG) return;
  for (const node of doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).createTreeWalker(() => true)) {
    if (!(node instanceof Y.XmlText)) continue;
    const items: string[] = [];
    for (let n = node._start; n; n = n.right) {
      const c = n.content;
      const body =
        c instanceof Y.ContentFormat
          ? `{${c.key.slice(-4)}=${(c.value as { draft?: string } | null)?.draft?.slice(-1) ?? "-"}}`
          : c instanceof Y.ContentString
            ? JSON.stringify(c.str)
            : c.constructor.name;
      items.push(`${n.deleted ? "~" : ""}${n.id.client}:${n.id.clock}${body}`);
    }
    process.stdout.write(`${label} ${items.join(" ")}\n`);
  }
}

const copy = (doc: Y.Doc) => {
  const out = new Y.Doc({ gc: false });
  Y.applyUpdate(out, Y.encodeStateAsUpdate(doc));
  return out;
};
const sync = (from: Y.Doc, to: Y.Doc) =>
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), "net");

function run(seed: number): string[] {
  rng = seed >>> 0;
  for (const e of editors.splice(0)) if (!e.isDestroyed) e.destroy();
  const server = new Y.Doc({ gc: false });
  server.clientID = 1;
  prosemirrorJSONToYXmlFragment(
    schema,
    {
      type: "doc",
      content: START.map((text, i) => ({
        type: "paragraph",
        attrs: { id: `p${i}` },
        content: [{ type: "text", text }],
      })),
    },
    server.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  for (let k = 1 + rnd(4); k > 0; k--) {
    const draft = DRAFTS[rnd(3)]!;
    suggestRewrite(server, schema, draft, { chat: draft, turn: `t${k}`, by: "agent" }, rnd(2), (text) => {
      const words = text.split(" ");
      for (let n = 1 + rnd(4); n > 0; n--) words[rnd(words.length)] = WORDS[rnd(WORDS.length)]!;
      return words.join(" ");
    });
  }
  const views: View[] = [{ draft: null }, ...DRAFTS.map((draft) => ({ draft }))];
  const pressed = DRAFTS[rnd(3)]!;
  const desk = tab(2, views[rnd(4)]!);
  const phone = tab(3, rnd(2) ? { draft: pressed } : { draft: null });
  sync(server, desk.doc);
  sync(server, phone.doc);
  for (let k = rnd(3); k > 0; k--) writerEdit(desk.editor);
  sync(desk.doc, server);
  sync(server, phone.doc);

  // The desk goes offline; the phone, or the server's press, resolves one draft.
  const base = copy(server);
  dump("BASE", server);
  for (let k = 1 + rnd(4); k > 0; k--) writerEdit(desk.editor);
  dump("DESK", desk.doc);
  const verdict = rnd(2) ? "accept" : "reject";
  if (rnd(2)) {
    pressStored(server, schema, verdict, { draft: pressed });
    sync(server, phone.doc);
  } else {
    if (verdict === "accept") phone.editor.commands.acceptSuggestions({ draft: pressed });
    else phone.editor.commands.rejectSuggestions({ draft: pressed });
    sync(phone.doc, server);
  }
  dump("PRESSED", server);
  const deskSide = copy(desk.doc);
  const serverSide = copy(server);

  // The desk reconnects, then moves its caret (the binding writes on any view update).
  sync(desk.doc, server);
  sync(server, desk.doc);
  desk.editor.view.dispatch(
    desk.editor.state.tr.setSelection(TextSelection.atStart(desk.editor.state.doc)),
  );
  for (let round = 0; round < 2; round++) {
    sync(desk.doc, server);
    sync(phone.doc, server);
    sync(server, desk.doc);
    sync(server, phone.doc);
  }
  dump("MERGED", server);

  const problems: string[] = [];
  const json = (doc: Y.Doc) => JSON.stringify(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toJSON());
  if (json(server) !== json(desk.doc) || json(server) !== json(phone.doc)) problems.push("diverged");
  const verdicts = server.getMap("suggestion_verdicts");
  const resolved = (value: string | undefined) => {
    const id = value && (JSON.parse(value) as { id?: string }).id;
    return !!id && (verdicts.has(`${id}:accept`) || verdicts.has(`${id}:reject`));
  };
  const was = charAttrs(base);
  const sides = [charAttrs(serverSide), charAttrs(deskSide)];
  for (const [char, merged] of charAttrs(server)) {
    const before = was.get(char);
    const keys = new Set([
      ...Object.keys(merged),
      ...sides.flatMap((side) => Object.keys(side.get(char) ?? {})),
    ]);
    for (const key of keys) {
      // Each side that has the character and changed this mark on it; with none, as it was.
      const changed = sides
        .filter((side) => side.has(char) && (!before || side.get(char)?.[key] !== before[key]))
        .map((side) => side.get(char)?.[key]);
      const allowed = new Set(changed.length > 0 ? changed : [before?.[key]]);
      if (resolved(merged[key])) problems.push(`${char} keeps resolved ${key}`);
      // A resolved change keeps no mark: what a side added to one goes (`dropResolvedMarks`).
      if ([...allowed].some(resolved)) allowed.add(undefined);
      if (!allowed.has(merged[key]))
        problems.push(`${char} ${key}: ${merged[key]} not in ${[...allowed].join(" | ")}`);
    }
  }
  return problems;
}

it(`no mark spreads when an offline tab reconnects after a press (seeds from ${seed0}, ${runs} runs)`, () => {
  const failed: string[] = [];
  for (let i = 0; i < runs; i++) {
    const problems = run(seed0 + i);
    if (problems.length > 0) failed.push(`seed ${seed0 + i}: ${problems.slice(0, 3).join("; ")}`);
  }
  expect(failed).toEqual([]);
}, 600_000);
