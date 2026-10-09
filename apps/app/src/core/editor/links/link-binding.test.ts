// @vitest-environment jsdom
/**
 * Every client producer binds the link it writes: a document it knows by id,
 * an indexed address by the local index, anything else internal to a fresh
 * ahead ref. External links stay unbound, and an unchanged submit keeps the
 * link it edits.
 */
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { afterEach, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import {
  insertDocumentReference,
  insertLinkAhead,
} from "../extensions/at-reference/document-link-insertion";
import { commitLinkDraft, resolveLinkDraft } from "./link-commands";
import { getLinkResolution } from "./link-storage";
import { linkPastedWikilinks } from "./wikilink-paste";

const HOLDER = "manuscript://volume-1/chapter-2.md";
const DOCUMENTS = [
  { documentId: "doc-ch2", uri: HOLDER },
  { documentId: "doc-ch1", uri: "manuscript://volume-1/chapter-1.md" },
  { documentId: "doc-lin", uri: "kb://characters/Lin Feng.md" },
];

const live: Editor[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

function editor(content = "<p>Kael waits.</p>"): Editor {
  const created = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  live.push(created);
  getLinkResolution(created)?.registerResolver(async (questions) => questions.map(() => null), {
    baseUri: HOLDER,
    projectId: "project-1",
    index: { documents: DOCUMENTS },
  });
  return created;
}

type Stored = { text: string; ref: string | null; href: string };

/** Every link run, with an ahead ref's random id masked. */
function links(target: Editor): Stored[] {
  const out: Stored[] = [];
  target.state.doc.descendants((node) => {
    const mark = node.marks.find((candidate) => candidate.type.name === "link");
    if (!mark || !node.text) return;
    const ref = mark.attrs.ref as string | null;
    out.push({
      text: node.text,
      ref: ref?.startsWith("ahead:") ? "ahead:*" : ref,
      href: mark.attrs.href,
    });
  });
  return out;
}

function ctrlK(target: Editor, from: number, to: number, href: string): Stored[] {
  target.commands.setTextSelection({ from, to });
  commitLinkDraft(target, resolveLinkDraft(target), { text: "", href });
  return links(target);
}

/** The browser's paste of clipboard text, through every plugin's paste props. */
function paste(target: Editor, text: string): Stored[] {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  target.view.dom.dispatchEvent(event);
  return links(target);
}

function wikilinks(text: string): Stored[] {
  const target = editor();
  const slice = new Slice(
    target.schema.nodes.paragraph.create(null, target.schema.text(text)).content,
    0,
    0,
  );
  const linked = linkPastedWikilinks(slice, target.schema, {
    holderUri: HOLDER,
    targets: DOCUMENTS,
    linkAhead: (name) => ({ uri: `manuscript://volume-1/${name}.md` }),
  });
  target.commands.insertContentAt(1, linked.content.toJSON());
  return links(target);
}

const STALE = '<p><a data-meridian-link="manuscript://volume-1/old-name.md">Kael</a> waits.</p>';

it("binds what each producer writes", () => {
  const rows: [string, () => Stored[], Stored[]][] = [
    [
      "@ document row: doc ref at its full address",
      () => {
        const target = editor();
        insertDocumentReference(
          target,
          { from: 1, to: 5 },
          {
            label: "Lin",
            documentId: "doc-lin",
            uri: "kb://characters/Lin Feng.md",
          },
        );
        return links(target);
      },
      [{ text: "Lin", ref: "doc:doc-lin", href: "kb://characters/Lin Feng.md" }],
    ],
    [
      "@ link-ahead row: ahead ref, extension added",
      () => {
        const target = editor();
        insertLinkAhead(
          target,
          { from: 1, to: 5 },
          {
            label: "Nine",
            uri: "manuscript://volume-1/chapter-9",
          },
        );
        return links(target);
      },
      [{ text: "Nine", ref: "ahead:*", href: "manuscript://volume-1/chapter-9.md" }],
    ],
    [
      "Ctrl+K new link to an indexed relative path: doc ref, absolute, suffix kept",
      () => ctrlK(editor(), 1, 5, "chapter-1.md#scene"),
      [{ text: "Kael", ref: "doc:doc-ch1", href: "manuscript://volume-1/chapter-1.md#scene" }],
    ],
    [
      "Ctrl+K new link to an external URL: unbound, as written",
      () => ctrlK(editor(), 1, 5, "https://example.com/kael"),
      [{ text: "Kael", ref: null, href: "https://example.com/kael" }],
    ],
    [
      "Ctrl+K unchanged submit: the link keeps its ref and stored href",
      () => {
        const target = editor(STALE);
        target.commands.setTextSelection({ from: 1, to: 5 });
        target.commands.setMark("link", {
          href: "manuscript://volume-1/old-name.md",
          title: null,
          ref: "doc:doc-moved",
        });
        return ctrlK(target, 2, 2, "manuscript://volume-1/old-name.md");
      },
      [{ text: "Kael", ref: "doc:doc-moved", href: "manuscript://volume-1/old-name.md" }],
    ],
    [
      "Ctrl+K retarget to an unwritten address: a fresh ahead ref",
      () => {
        const target = editor(STALE);
        target.commands.setTextSelection({ from: 1, to: 5 });
        target.commands.setMark("link", {
          href: "manuscript://volume-1/old-name.md",
          title: null,
          ref: "doc:doc-moved",
        });
        return ctrlK(target, 2, 2, "chapter-7");
      },
      [{ text: "Kael", ref: "ahead:*", href: "manuscript://volume-1/chapter-7.md" }],
    ],
    [
      "[[…]] paste hit: doc ref by catalog id",
      () => wikilinks("[[Lin Feng]]"),
      [{ text: "Lin Feng", ref: "doc:doc-lin", href: "kb://characters/Lin Feng.md" }],
    ],
    [
      "[[…]] paste miss: ahead ref at the link-ahead address",
      () => wikilinks("[[chapter-9#Gate]]"),
      [{ text: "chapter-9", ref: "ahead:*", href: "manuscript://volume-1/chapter-9.md#Gate" }],
    ],
    [
      "Markdown paste: indexed, unwritten and external links each bound by pass 3",
      () =>
        paste(
          editor("<p></p>"),
          "[One](chapter-1.md), [Nine](chapter-9) and [Web](https://example.com).",
        ),
      [
        { text: "One", ref: "doc:doc-ch1", href: "manuscript://volume-1/chapter-1.md" },
        { text: "Nine", ref: "ahead:*", href: "manuscript://volume-1/chapter-9.md" },
        { text: "Web", ref: null, href: "https://example.com" },
      ],
    ],
  ];
  for (const [label, produce, expected] of rows) {
    expect.soft(produce(), label).toEqual(expected);
  }
});
