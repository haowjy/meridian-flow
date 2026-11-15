import { writeFileSync } from "node:fs";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME, withBlockIds } from "@meridian/prosemirror-schema";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { it } from "vitest";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { createAgentEditCodecFactory } from "../codec-adapter.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { applyTextEdit } from "../test-support/text-edit.js";
import { type ResolveWriteParams, resolveWrite } from "./resolve.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);
type Writer = (room: Y.Doc) => void;
const none: Writer = () => {};
const del = (text: string): Writer => (room) => {
  const block = model.getBlocks(room)[0];
  const from = model.getText(block).indexOf(text);
  applyTextEdit(block, { from, to: from + text.length }, "");
};
const typeBefore = (anchor: string, text: string): Writer => (room) => {
  let y = room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0);
  while (!(y instanceof Y.XmlText)) y = (y as Y.XmlElement).get(0);
  const from = y.toString().indexOf(anchor);
  for (const [i, ch] of [...text].entries()) y.insert(from + i, ch);
};
const retype = (old: string, text: string): Writer => (room) => {
  let y = room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0);
  while (!(y instanceof Y.XmlText)) y = (y as Y.XmlElement).get(0);
  const from = y.toString().indexOf(old);
  y.delete(from, old.length);
  for (const [i, ch] of [...text].entries()) y.insert(from + i, ch);
};
const R = (find: string, content: string, extra: object = {}) => ({ command: "replace", find, content, ...extra });

const cases: Array<[string, string, object, Writer]> = [
  ["base", "One small step for a cat.", R("One small", "One big"), none],
  ["kept word deleted", "One small step for a cat.", R("One small", "One big"), del("One ")],
  ["kept word retyped", "One small step for a cat.", R("One small", "One big"), retype("One", "A")],
  ["changed word deleted", "One small step for a cat.", R("One small", "One big"), del("small ")],
  ["whole window deleted", "One small step for a cat.", R("One small", "One big"), del("One small ")],
  ["window middle kept+deleted", "The old grey cat sat down.", R("old grey cat sat", "young grey cat stood"), del("grey cat ")],
  ["type before changed word", "One small step for a cat.", R("One small", "One big"), typeBefore("small", "very ")],
  ["type inside kept word", "One small step for a cat.", R("One small", "One big"), typeBefore("ne small", "XX")],
  ["type after window", "One small step for a cat.", R("One small", "One big"), typeBefore(" step", "er")],
  ["type inside changed word", "One small step for a cat.", R("One small", "One big"), typeBefore("all step", "XX")],
  ["bold part kept", "One **small** step for a cat.", R("One small", "One **big**"), none],
  ["mark only", "One small step for a cat.", R("One small", "One **small**"), none],
  ["mark only, writer types inside", "One small step for a cat.", R("One small", "One **small**"), typeBefore("all step", "XX")],
  ["drop bold in window", "One **small** step for a cat.", R("One small", "A small"), none],
  ["link in window", "See [the old map](https://example.com/m) now.", R("See the old map", "Read the old map"), none],
  ["link text changed", "See [the old map](https://example.com/m) now.", R("the old map", "the new map"), none],
  ["link as content", "See [the old map](https://example.com/m) now.", R("[the old map](https://example.com/m) now", "[the old map](https://example.com/m) today"), none],
  ["hard break in window", "Line one\\\nand more words.", R("one\\\nand more", "one\\\nand fewer"), none],
  ["image in window", "A ![pic](https://example.com/a.png) small B.", R("small B", "big B"), none],
  ["cjk", "他慢慢地走了出去，天黑了。", R("慢慢地走了出去", "慢慢地跑了出去"), none],
  ["cjk kept deleted", "他慢慢地走了出去，天黑了。", R("慢慢地走了出去", "慢慢地跑了出去"), del("慢慢地")],
  ["punct", "Hello, world. Bye.", R("Hello, world", "Hello; world"), none],
  ["whitespace", "One  small step.", R("One  small", "One small"), none],
  ["repeat", "A very big cat.", R("very big", "very big big"), none],
  ["repeat shrink", "A very big big cat.", R("very big big", "very big"), none],
  ["repeat, kept deleted", "A very big cat.", R("very big", "very big big"), del("big ")],
  ["letters only", "A very big cat.", R("very big", "very bigger"), none],
  ["all", "big cat, big dog, big sky.", R("big", "bigger", { all: true }), none],
  ["reorder", "First. Second. Third.", R("First. Second.", "Second. First."), del("Second. ")],
];
const cross: Array<[string, string, object, Writer]> = [
  ["cross block", "End of one.\n\nStart of two.", R("one.\n\nStart", "ONE.\n\nBegin"), none],
  ["list item", "- One small step\n- two", R("One small", "One big"), none],
  ["table cell", "| a | b |\n| --- | --- |\n| One small | two |", R("One small", "One big"), none],
];


const W = (content: string) => ({ command: "replace", wholeDocument: true, content });
const more: Array<[string, string, object, Writer]> = [
  ["break added in window", "Line one and more words.", R("one and more", "one\\\nand more"), none],
  ["break added, writer types in tail", "Line one and more words.", R("one and more", "one\\\nand more"), typeBefore(" words", "XX")],
  ["break removed in window", "Line one\\\nand more words.", R("one\\\nand more", "one and more"), none],
  ["image added in window", "A small B.", R("A small", "A ![pic](https://example.com/a.png) small"), none],
  ["link added over kept words", "See the old map now.", R("See the old map", "See [the old map](https://example.com/m)"), typeBefore("old", "very ")],
  ["bold added, writer deletes kept", "One small step for a cat.", R("One small step", "One **small** step"), del("small ")],
];

function run(markdown: string, write: object, writer: Writer) {
  const room = new Y.Doc({ gc: false });
  room.clientID = 1;
  prosemirrorToYXmlFragment(schema.node("doc", null, codec.parse(markdown).blocks.map((b) => withBlockIds(b))), room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  const view = new Y.Doc({ gc: false });
  view.clientID = 2;
  Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
  const seen = Y.encodeStateVector(view);
  room.clientID = 3;
  writer(room);
  const resolved = resolveWrite({ doc: view, model, codec, links: "preassigned" }, { documentAddress: { documentId: "123e4567-e89b-12d3-a456-426614174000", filePath: "c.md" }, ...write } as ResolveWriteParams);
  if (!resolved.ok) return { out: `ERR ${resolved.error.message}`, ops: "" };
  const ops = JSON.stringify(resolved.edits.map((e: any) => (e.ops ?? e.kind === "ops" ? (e.ops ?? []).map((o: any) => o.kind === "text" ? { s: o.splices.map((s: any) => [s.from, s.to, s.content.textBetween(0, s.content.size, "", "□")]), f: o.formats.map((f: any) => [f.from, f.to, f.mark, f.attrs === null ? "off" : "on"]) } : o.kind) : e.kind)));
  applyEdits(view, model, resolved.edits, { type: "agent", actorTurnId: "turn-1" });
  Y.applyUpdate(room, Y.encodeStateAsUpdate(view, seen));
  return { out: codec.serialize(model.projectBlocks(room).map((b) => b.node)).trim().replace(/\n/g, "⏎"), ops };
}

it("prints", () => {
  const lines: string[] = [];
  for (const [name, md, write, writer] of [...more]) {
    delete process.env.WINDOW_DIFF;
    const today = run(md, write, writer);
    process.env.WINDOW_DIFF = "1";
    const next = run(md, write, writer);
    delete process.env.WINDOW_DIFF;
    lines.push(`## ${name}: ${md.replace(/\n/g, "⏎")} | ${JSON.stringify(write)}`);
    lines.push(`  today: ${today.out}\n         ${today.ops}`);
    lines.push(today.out === next.out && today.ops === next.ops ? "  change: same" : `  change: ${next.out}\n         ${next.ops}`);
  }
  writeFileSync("/tmp/p17768/cases4.txt", lines.join("\n"));
});
