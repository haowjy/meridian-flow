/**
 * SPIKE (not for merge): sizes one lowering for every block type. Each row builds a room,
 * edits it as the writer, plans a model write on the older view, merges it, and prints the
 * room's Markdown for `main`'s lowering and for minimal operations, at both client orders.
 * Rows with `want` assert the minimal-operations result.
 */

import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { createAgentEditCodecFactory } from "../codec-adapter.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import {
  captureEditFrontier,
  captureEditParts,
  computeInverse,
  type InversePart,
} from "../undo/forward-inverse.js";
import { type ResolveWriteParams, resolveWrite } from "./resolve.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);

type Writer = (room: Y.Doc) => void;

function textHolding(room: Y.Doc, needle: string): { text: Y.XmlText; from: number } {
  let found: { text: Y.XmlText; from: number } | undefined;
  const visit = (type: Y.XmlFragment | Y.XmlElement) => {
    for (const child of type.toArray()) {
      if (found) return;
      if (child instanceof Y.XmlText) {
        const plain = (child.toDelta() as Array<{ insert?: unknown }>)
          .map((d) => (typeof d.insert === "string" ? d.insert : "￼"))
          .join("");
        const from = plain.indexOf(needle);
        if (from >= 0) found = { text: child, from };
      } else if (child instanceof Y.XmlElement) visit(child);
    }
  };
  visit(room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  if (!found) throw new Error("writer text not found");
  return found;
}

/** The writer selecting `old` and typing `text` in the browser: a delete, then one insert per key. */
const retype =
  (old: string, text: string): Writer =>
  (room) => {
    const { text: ytext, from } = textHolding(room, old);
    ytext.delete(from, old.length);
    for (const [index, char] of [...text].entries()) ytext.insert(from + index, char);
  };
const del = (old: string): Writer => retype(old, "");
const typeAfter =
  (anchor: string, text: string): Writer =>
  (room) => {
    const { text: ytext, from } = textHolding(room, anchor);
    for (const [index, char] of [...text].entries())
      ytext.insert(from + anchor.length + index, char);
  };
const format =
  (old: string, attrs: Record<string, unknown>): Writer =>
  (room) => {
    const { text: ytext, from } = textHolding(room, old);
    ytext.format(from, old.length, attrs);
  };
const top = (room: Y.Doc, index: number) =>
  room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(index) as Y.XmlElement;

const rewrite = (markdown: string) =>
  ({ command: "replace", wholeDocument: true, content: markdown }) as const;
const find = (text: string, content: string) => ({ command: "replace", find: text, content });
const insertAfter = (text: string, content: string) => ({ command: "insert", find: text, content });

const LINE = " DRAFT-B line.";
const TEXT = `A disciple.${LINE} SIDETEXT`;
const SIGHED = "He sighed, and then he wept.";
const typedOver = retype(", and then he wept", " loudly");

type Row = [name: string, markdown: string, write: object, writer: Writer, want?: string];

const rows: Row[] = [
  // ── Formatted flat text: format ranges on the splice path ──
  [
    "F1 bold before typed-over text",
    SIGHED,
    rewrite("He **sighed**, and then he wept."),
    typedOver,
    "He **sighed** loudly.",
  ],
  [
    "F2 bold across a cut passage",
    "Keep this. Cut it. Keep end.",
    rewrite("Keep **this. Cut it. Keep** end."),
    del("Cut it. "),
    "Keep **this. Keep** end.",
  ],
  [
    "F3 bold on a word the writer deleted",
    "the slowly moving train",
    rewrite("the **slowly** moving train"),
    del(" slowly"),
    "the moving train",
  ],
  [
    "F4 bold and insert beside a discarded line",
    TEXT,
    rewrite(`A **disciple**. DRAFT-B2.${LINE} SIDETEXT`),
    del(LINE),
    "A **disciple**. DRAFT-B2. SIDETEXT",
  ],
  [
    "F5 bold and a word change, typed over",
    SIGHED,
    rewrite("He **groaned**, and then he wept."),
    typedOver,
    "He **groaned** loudly.",
  ],
  [
    "F6 model italic overlaps writer bold",
    SIGHED,
    rewrite("He sighed, *and then* he wept."),
    format("sighed, and", { strong: {} }),
    "He **sighed, *and***_&#x20;then_ he wept.",
  ],
  [
    "F7 model unbolds, writer types inside",
    "He **sighed loudly** again.",
    rewrite("He sighed loudly again."),
    typeAfter("sighed", " very"),
    undefined,
  ],
  [
    "F8 model links a word, writer deleted beside it",
    SIGHED,
    rewrite("He [sighed](https://x.test/a), and then he wept."),
    typedOver,
    "He [sighed](https://x.test/a) loudly.",
  ],
  [
    "F9 model bolds, writer bolded the same word",
    SIGHED,
    rewrite("He **sighed**, and then he wept."),
    format("sighed", { strong: {} }),
    "He **sighed**, and then he wept.",
  ],
  [
    "F10 find replace with bold content, typed over",
    SIGHED,
    find("sighed", "**groaned**"),
    typedOver,
    "He **groaned** loudly.",
  ],
  [
    "F11 bold on text half deleted",
    "Keep this. Cut it. Keep end.",
    rewrite("Keep this. **Cut it. Keep** end."),
    del("Cut it. "),
    "Keep this. **Keep** end.",
  ],
  [
    "F12 CJK bold beside a cut phrase",
    "他慢慢地走了出去，天黑了。",
    rewrite("他慢慢地**走了出去**，天黑了。"),
    del("慢慢地"),
    "他**走了出去**，天黑了。",
  ],
  // ── Nested: quote ──
  [
    "Q1 find insert beside a discarded line",
    `> ${TEXT}`,
    insertAfter("disciple.", " DRAFT-B2."),
    del(LINE),
    "> A disciple. DRAFT-B2. SIDETEXT",
  ],
  [
    "Q2 rewrite that inserts",
    `> ${TEXT}`,
    rewrite(`> A disciple. DRAFT-B2.${LINE} SIDETEXT`),
    del(LINE),
    "> A disciple. DRAFT-B2. SIDETEXT",
  ],
  [
    "Q3 rewrite changing the deleted line",
    `> ${TEXT}`,
    rewrite("> A pupil. DRAFT-B3 line. SIDETEXT now"),
    del(LINE),
    "> A pupil. SIDETEXT now",
  ],
  [
    "Q4 replace of the deleted line",
    `> ${TEXT}`,
    find("DRAFT-B line.", "DRAFT-B3 line."),
    del(LINE),
    "> A disciple. SIDETEXT",
  ],
  [
    "Q5 word changed, typed over",
    `> ${SIGHED}`,
    find("sighed", "sighs"),
    typedOver,
    "> He sighs loudly.",
  ],
  [
    "Q6 word retyped by the writer",
    `> ${SIGHED}`,
    find("sighed", "sighs"),
    retype("sighed", "groaned"),
    "> He groaned, and then he wept.",
  ],
  [
    "Q7 bold, typed over",
    `> ${SIGHED}`,
    rewrite("> He **sighed**, and then he wept."),
    typedOver,
    "> He **sighed** loudly.",
  ],
  [
    "Q8 find insert after a deleted word",
    "> the slowly moving train",
    insertAfter("slowly", ", steadily"),
    del(" slowly"),
    "> the moving train",
  ],
  [
    "Q9 second paragraph deleted, model edits it",
    "> Alpha beta.\n>\n> Gamma delta.",
    rewrite("> Alpha beta.\n>\n> Gamma epsilon."),
    (room) => top(room, 0).delete(1, 1),
    "> Alpha beta.",
  ],
  [
    "Q10 model adds a paragraph, writer types in the first",
    "> Alpha beta.",
    rewrite("> Alpha beta.\n>\n> New para."),
    typeAfter("Alpha", " WRITER"),
    "> Alpha WRITER beta.\n>\n> New para.",
  ],
  [
    "Q11 Chinese clause, phrase cut",
    "> 他慢慢地走了出去，天黑了。",
    rewrite("> 他慢慢地跑了出去，天黑了。"),
    del("慢慢地"),
    "> 他跑了出去，天黑了。",
  ],
  // ── Nested: list ──
  [
    "L1 find insert beside a discarded line",
    `- ${TEXT}`,
    insertAfter("disciple.", " DRAFT-B2."),
    del(LINE),
    "- A disciple. DRAFT-B2. SIDETEXT",
  ],
  [
    "L2 word changed, typed over",
    `- ${SIGHED}`,
    find("sighed", "sighs"),
    typedOver,
    "- He sighs loudly.",
  ],
  [
    "L3 item deleted, model edits it",
    "- one\n- two\n- three",
    find("two", "2"),
    (room) => top(room, 0).delete(1, 1),
    "- one\n- three",
  ],
  [
    "L4 model adds an item beside a deleted one",
    "- one\n- two\n- three",
    rewrite("- one\n- two\n- two and a half\n- three"),
    (room) => top(room, 0).delete(1, 1),
    "- one\n- two and a half\n- three",
  ],
  [
    "L5 model removes an item the writer typed in",
    "- one\n- two\n- three",
    rewrite("- one\n- three"),
    typeAfter("two", " WRITER"),
    "- one\n- three",
  ],
  [
    "L6 model reorders items, writer edits one",
    "- one\n- two\n- three",
    rewrite("- three\n- one\n- two"),
    typeAfter("two", " WRITER"),
    undefined,
  ],
  [
    "L7 nested item, typed over",
    `- outer\n  - ${SIGHED}`,
    find("sighed", "sighs"),
    typedOver,
    "- outer\n  - He sighs loudly.",
  ],
  [
    "L8 list to paragraphs, writer edits an item",
    "- one\n- two",
    rewrite("one\n\ntwo"),
    typeAfter("two", " WRITER"),
    undefined,
  ],
  [
    "L9 bullet to ordered, writer edits an item",
    "- one\n- two",
    rewrite("1. one\n2. two"),
    typeAfter("two", " WRITER"),
    undefined,
  ],
  [
    "L10 task checked by model, writer edits text",
    "- [ ] buy milk",
    rewrite("- [x] buy milk"),
    typeAfter("milk", " now"),
    "- [x] buy milk now",
  ],
  // ── Verse / hard break ──
  [
    "V1 line deleted, model edits another",
    "Line one\\\nLine two\\\nLine three",
    find("three", "3"),
    (room) => top(room, 0).delete(2, 2),
    "Line one\\\nLine 3",
  ],
  [
    "V2 model edits the deleted line",
    "Line one\\\nLine two\\\nLine three",
    find("two", "2"),
    (room) => top(room, 0).delete(2, 2),
    "Line one\\\nLine three",
  ],
  [
    "V3 word changed, typed over",
    `Before\\\n${SIGHED}`,
    find("sighed", "sighs"),
    typedOver,
    "Before\\\nHe sighs loudly.",
  ],
  [
    "V4 model adds a line, writer types",
    "Line one\\\nLine two",
    rewrite("Line one\\\nLine mid\\\nLine two"),
    typeAfter("two", " WRITER"),
    "Line one\\\nLine mid\\\nLine two WRITER",
  ],
  // ── Code block ──
  [
    "C1 line deleted, model changes lines around",
    "```\nlet a = 1;\nlet b = 2;\nlet c = 3;\n```",
    rewrite("```\nlet a = 10;\nlet b = 2;\nlet c = 30;\n```"),
    del("let b = 2;\n"),
    "```\nlet a = 10;\nlet c = 30;\n```",
  ],
  [
    "C2 language set by model, writer edits code",
    "```\nlet a = 1;\n```",
    rewrite("```ts\nlet a = 1;\n```"),
    typeAfter("a = 1", "0"),
    "```ts\nlet a = 10;\n```",
  ],
  // ── Table ──
  [
    "T1 cell word changed, typed over",
    `| a | b |\n| --- | --- |\n| ${SIGHED} | x |`,
    find("sighed", "sighs"),
    typedOver,
    undefined,
  ],
  [
    "T2 model adds a row, writer edits a cell",
    "| a | b |\n| --- | --- |\n| one | two |",
    rewrite("| a | b |\n| --- | --- |\n| one | two |\n| three | four |"),
    typeAfter("two", " WRITER"),
    undefined,
  ],
  // ── Attributes ──
  [
    "A1 writer changes level, model rewrites text",
    "# Chapter One",
    rewrite("# Chapter Two"),
    (room) => top(room, 0).setAttribute("level", 2 as unknown as string),
    "## Chapter Two",
  ],
  [
    "A2 model changes level, writer edits text",
    "# Chapter One",
    rewrite("## Chapter One"),
    typeAfter("One", " WRITER"),
    "## Chapter One WRITER",
  ],
  [
    "A3 both change level",
    "# Chapter One",
    rewrite("## Chapter One"),
    (room) => top(room, 0).setAttribute("level", 3 as unknown as string),
    "### Chapter One",
  ],
  [
    "A4 paragraph to heading, writer edits text",
    "Chapter One",
    rewrite("# Chapter One"),
    typeAfter("One", " WRITER"),
    undefined,
  ],
  // ── Top-level structure ──
  [
    "S1 model splits a paragraph, writer types in the tail",
    "First half. Second half.",
    rewrite("First half.\n\nSecond half."),
    typeAfter("Second", " WRITER"),
    undefined,
  ],
  [
    "S2 model joins paragraphs, writer deleted a word in the second",
    "First half.\n\nSecond half here.",
    rewrite("First half. Second half here."),
    del(" half here"),
    undefined,
  ],
];

function run(row: Row, modelClient: number, minimalOps: boolean): string {
  const [, markdown, write, writer] = row;
  const room = new Y.Doc({ gc: false });
  room.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, codec.parse(markdown).blocks),
    room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  const view = new Y.Doc({ gc: false });
  view.clientID = modelClient;
  Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
  const seen = Y.encodeStateVector(view);
  room.clientID = 3;
  try {
    writer(room);
    const resolved = resolveWrite(
      { doc: view, model, codec, links: "preassigned", current: room, minimalOps },
      {
        documentAddress: { documentId: "123e4567-e89b-12d3-a456-426614174000", filePath: "c.md" },
        ...write,
      } as ResolveWriteParams,
    );
    if (!resolved.ok) return `ERROR ${resolved.error.code}`;
    if (resolved.edits.length > 0) {
      const applied = applyEdits(view, model, resolved.edits, { type: "agent", actorTurnId: "t" });
      if (!applied.ok) return `APPLY ${applied.error.code}: ${applied.error.message}`;
    }
    Y.applyUpdate(room, Y.encodeStateAsUpdate(view, seen));
    const blocks = model.projectBlocks(room).map((block) => block.node);
    const kinds = [...new Set(resolved.edits.map((edit) => edit.kind))].join("+") || "none";
    return `${codec.serialize(blocks).trim()}${resolved.skipped ? `  [skipped ${resolved.skipped}]` : ""}  {${kinds}}`;
  } catch (cause) {
    return `THROW ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

const show = (value: string) => value.replace(/\n/g, "⏎");

it("prints every case", () => {
  const lines: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    const main = [2, 4].map((client) => run(row, client, false));
    const ops = [2, 4].map((client) => run(row, client, true));
    lines.push(`\n${row[0]}`);
    lines.push(
      `  main: ${main[0] === main[1] ? show(main[0]) : `${show(main[0])}  |hi| ${show(main[1])}`}`,
    );
    lines.push(
      `  ops : ${ops[0] === ops[1] ? show(ops[0]) : `${show(ops[0])}  |hi| ${show(ops[1])}`}`,
    );
    if (row[4] !== undefined)
      for (const result of ops)
        if (result.replace(/ {2}(\[skipped \d+\] {2})?\{[^}]*\}$/, "") !== row[4])
          failed.push(`${row[0]}: want ${show(row[4])}, got ${show(result)}`);
  }
  console.log(lines.join("\n"));
  expect(failed).toEqual([]);
});

/** Undo of the model's write, by the package's forward inverse, must give the writer's text back. */
function undoRun(row: Row, modelClient: number, minimalOps: boolean): string {
  const [, markdown, write, writer] = row;
  const room = new Y.Doc({ gc: false });
  room.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, codec.parse(markdown).blocks),
    room.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  const view = new Y.Doc({ gc: false });
  view.clientID = modelClient;
  Y.applyUpdate(view, Y.encodeStateAsUpdate(room));
  room.clientID = 3;
  const md = (doc: Y.Doc) =>
    codec.serialize(model.projectBlocks(doc).map((block) => block.node)).trim();
  try {
    writer(room);
    const writerText = md(room);
    const resolved = resolveWrite(
      { doc: view, model, codec, links: "preassigned", current: room, minimalOps },
      {
        documentAddress: { documentId: "123e4567-e89b-12d3-a456-426614174000", filePath: "c.md" },
        ...write,
      } as ResolveWriteParams,
    );
    if (!resolved.ok) return `ERROR ${resolved.error.code}`;
    if (resolved.edits.length === 0) return "nothing written";
    const frontier = captureEditFrontier(view);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(update);
    view.on("update", collect);
    const applied = applyEdits(view, model, resolved.edits, { type: "agent", actorTurnId: "t" });
    view.off("update", collect);
    if (!applied.ok) return `APPLY ${applied.error.code}`;
    const update = Y.mergeUpdates(updates);
    Y.applyUpdate(room, update);
    const landed = md(room);
    const history: InversePart[] = captureEditParts(view, [{ frontier, update }]).map(
      (part, ordinal) => ({
        ...part,
        id: 1 + ordinal,
        editId: "e1",
        ordinal,
        kind: "write" as const,
        targets: [],
      }),
    );
    const cold = new Y.Doc({ gc: false });
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(room));
    let next = 9000;
    const result = computeInverse(
      cold,
      history,
      history.map((part) => ({ part, direction: "invert" as const })),
      { actionId: "a1", allocateClient: () => next++ },
    );
    for (const edit of result.edits)
      for (const part of edit.parts) Y.applyUpdate(cold, part.update);
    const undone = md(cold);
    if (undone === writerText) return "ok";
    return `DIFFERS landed=${show(landed)} undone=${show(undone)} writer=${show(writerText)} skipped=${result.skipped.length}`;
  } catch (cause) {
    return `THROW ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

it("prints undo of every case", () => {
  const lines: string[] = [];
  for (const row of rows) {
    const main = [2, 4].map((client) => undoRun(row, client, false));
    const ops = [2, 4].map((client) => undoRun(row, client, true));
    const fold = (pair: string[]) => (pair[0] === pair[1] ? pair[0] : `${pair[0]} |hi| ${pair[1]}`);
    lines.push(`${row[0]}\n  main undo: ${fold(main)}\n  ops  undo: ${fold(ops)}`);
  }
  console.log(lines.join("\n"));
});

/**
 * Class run: every container x writer edit x model write, at both client orders. A result is
 * clean when it is the writer's text with the model's change made whole, or (for a change to
 * text the writer deleted) the writer's text untouched. Anything else is garbled.
 */
it("class run", () => {
  const wrappers: Array<[string, (text: string) => string]> = [
    ["paragraph", (t) => t],
    ["bold-led paragraph", (t) => `**Lead.** ${t}`],
    ["heading", (t) => `## ${t}`],
    ["quote", (t) => `> ${t}`],
    ["quote, 2nd paragraph", (t) => `> First.\n>\n> ${t}`],
    ["bullet", (t) => `- ${t}`],
    ["ordered", (t) => `1. ${t}`],
    ["nested list", (t) => `- outer\n  - ${t}`],
    ["verse", (t) => `Before\\\n${t}\\\nAfter`],
    ["table cell", (t) => `| h | k |\n| --- | --- |\n| ${t} | x |`],
    ["link paragraph", (t) => `${t} [site](https://x.test/a)`],
    ["code block", (t) => `\`\`\`\n${t}\n\`\`\``],
  ];
  type Case = [
    name: string,
    write: object | ((w: (t: string) => string) => object),
    landed: ((t: string) => string) | null,
  ];
  const sub = (from: string, to: string) => (t: string) => t.replace(from, to);
  const bases: Array<[text: string, gone: string, typed: string, cases: Case[]]> = [
    [
      TEXT,
      LINE,
      " MINE.",
      [
        [
          "find insert",
          insertAfter("disciple.", " DRAFT-B2."),
          sub("disciple.", "disciple. DRAFT-B2."),
        ],
        ["find replace word", find("disciple", "pupil"), sub("disciple", "pupil")],
        ["find replace of gone text", find("DRAFT-B line.", "DRAFT-B3 line."), null],
        [
          "rewrite insert",
          (w) => rewrite(w(`A disciple. DRAFT-B2.${LINE} SIDETEXT`)),
          sub("disciple.", "disciple. DRAFT-B2."),
        ],
        ["rewrite word", (w) => rewrite(w(`A pupil.${LINE} SIDETEXT`)), sub("disciple", "pupil")],
        [
          "rewrite word + bold",
          (w) => rewrite(w(`A **pupil**.${LINE} SIDETEXT`)),
          sub("disciple", "**pupil**"),
        ],
        [
          "rewrite tail",
          (w) => rewrite(w(`A disciple.${LINE} SIDETEXT now`)),
          sub("SIDETEXT", "SIDETEXT now"),
        ],
        [
          "rewrite gone text + word",
          (w) => rewrite(w("A pupil. DRAFT-B3 line. SIDETEXT")),
          sub("disciple", "pupil"),
        ],
      ],
    ],
    [
      SIGHED,
      ", and then he wept",
      " loudly",
      [
        ["find replace word", find("sighed", "sighs"), sub("sighed", "sighs")],
        ["find insert", insertAfter("He", " really"), sub("He", "He really")],
        [
          "rewrite bold",
          (w) => rewrite(w("He **sighed**, and then he wept.")),
          sub("sighed", "**sighed**"),
        ],
        [
          "rewrite word",
          (w) => rewrite(w("He groaned, and then he wept.")),
          sub("sighed", "groaned"),
        ],
        ["find replace of gone text", find("wept", "cried"), null],
      ],
    ],
    [
      "他慢慢地走了出去，天黑了。",
      "慢慢地",
      "飞快地",
      [
        ["rewrite char", (w) => rewrite(w("他慢慢地跑了出去，天黑了。")), sub("走", "跑")],
        ["find replace char", find("走", "跑"), sub("走", "跑")],
        ["find insert", insertAfter("天黑了", "很久"), sub("天黑了", "天黑了很久")],
      ],
    ],
  ];
  const norm = (markdown: string) => codec.serialize(codec.parse(markdown).blocks).trim();
  const zero = () => ({ cases: 0, landed: 0, skipped: 0, garbled: 0, byOrder: 0, error: 0 });
  const tally = { main: zero(), ops: zero() };
  const bad: string[] = [];
  for (const [wrapName, wrap] of wrappers)
    for (const [text, gone, typed, cases] of bases)
      for (const [editName, writer, writerText] of [
        ["deleted", del(gone), text.replace(gone, "")],
        ["typed over", retype(gone, typed), text.replace(gone, typed)],
      ] as Array<[string, Writer, string]>)
        for (const [name, make, landed] of cases) {
          if (wrapName === "code block" && name.includes("bold")) continue;
          const write = typeof make === "function" ? make(wrap) : make;
          const row: Row = [name, wrap(text), write, writer];
          const untouched = norm(wrap(writerText));
          const whole = landed ? norm(wrap(landed(writerText))) : null;
          for (const lowering of ["main", "ops"] as const) {
            const results = [2, 4].map((client) =>
              run(row, client, lowering === "ops").replace(
                / {2}(\[skipped \d+\] {2})?\{[^}]*\}$/,
                "",
              ),
            );
            const t = tally[lowering];
            t.cases += 1;
            const label = `${lowering} | ${wrapName} | ${editName} | ${name}`;
            if (results.some((r) => /^(ERROR|APPLY|THROW)/.test(r))) {
              t.error += 1;
              if (lowering === "ops") bad.push(`${label}: ${show(results[0])}`);
              continue;
            }
            if (results[0] !== results[1]) t.byOrder += 1;
            if (results.every((r) => r === whole)) t.landed += 1;
            else if (results.every((r) => r === untouched)) t.skipped += 1;
            else {
              t.garbled += 1;
              if (lowering === "ops")
                bad.push(`${label}: ${show(results[0])} |hi| ${show(results[1])}`);
            }
          }
        }
  console.log(JSON.stringify(tally));
  console.log(bad.join("\n"));
});
