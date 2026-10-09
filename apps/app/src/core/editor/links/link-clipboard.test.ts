// @vitest-environment jsdom
/**
 * Clipboard link metadata carries what a link names into the paste, keeps a
 * ref only inside its own project, and never injects an href; plain text
 * spells current full addresses and never an id.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Schema, Slice } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { expect, it } from "vitest";

import { markdownClipboardSerializer } from "../markdown-paste";
import { LINK_KEPT_REF_ATTRIBUTE, linkClipboardPlugin } from "./link-clipboard";
import { createLinkAnswerCache, type LinkAnswer } from "./link-resolution";

const schema = new Schema({
  nodes: { doc: { content: "text*" }, text: {} },
  marks: {
    link: {
      attrs: { href: {}, ref: { default: null } },
      toDOM: (mark) => ["a", { "data-meridian-link": mark.attrs.href }, 0],
    },
  },
});

const KAEL_REF = "doc:00000000-0000-4000-8000-00000000000a";
const MOVED = "00000000-0000-4000-8000-00000000000d";
const GONE = "00000000-0000-4000-8000-00000000000e";
const AHEAD = "ahead:00000000-0000-4000-8000-0000000000a1";

function clipboard(holder: string | null, projectId = "project-a") {
  const resolution = createLinkAnswerCache();
  resolution.registerResolver(
    { remote: async (questions) => questions.map(() => null) },
    {
      baseUri: holder,
      projectId,
    },
  );
  return linkClipboardPlugin(schema, resolution);
}

function paste(html: string, holder: string | null, projectId = "project-a") {
  const plugin = clipboard(holder, projectId);
  return plugin.props.transformPastedHTML?.call(plugin, html, null as never);
}

it("carries what a copied link names across the clipboard", () => {
  const rows = [
    {
      row: "a relative link pastes as the address it named",
      copied: { from: "manuscript://a/source.md", href: "target.md#scene", ref: null },
      into: { holder: "manuscript://b/new.md", project: "project-a" },
      pasted: { link: "manuscript://a/target.md#scene", ref: null },
    },
    {
      row: "a contextual Scratch link keeps the Work it meant",
      copied: { from: "scratch://@revision/notes/a.md", href: "scratch://plan.md", ref: null },
      into: { holder: "scratch://@other/b.md", project: "project-a" },
      pasted: { link: "scratch://@revision/plan.md", ref: null },
    },
    {
      row: "a same-project paste keeps the ref",
      copied: { from: "manuscript://a/source.md", href: "manuscript://a/kael.md", ref: KAEL_REF },
      into: { holder: "manuscript://b/new.md", project: "project-a" },
      pasted: { link: "manuscript://a/kael.md", ref: KAEL_REF },
    },
    {
      row: "another project's paste drops the ref for a fresh assignment",
      copied: { from: "manuscript://a/source.md", href: "manuscript://a/kael.md", ref: KAEL_REF },
      into: { holder: "manuscript://b/new.md", project: "project-b" },
      pasted: { link: "manuscript://a/kael.md", ref: null },
    },
  ];
  for (const { row, copied, into, pasted } of rows) {
    const fragment = schema.node(
      "doc",
      null,
      schema.text("x", [schema.marks.link.create({ href: copied.href, ref: copied.ref })]),
    ).content;
    const html = document.createElement("div");
    const serializer = clipboard(copied.from).props.clipboardSerializer;
    if (!serializer) throw new Error("Missing clipboard serializer");
    html.append(serializer.serializeFragment(fragment));
    const container = document.createElement("template");
    container.innerHTML = paste(html.innerHTML, into.holder, into.project) ?? "";
    const anchor = container.content.querySelector("a");
    expect
      .soft(
        {
          link: anchor?.getAttribute("data-meridian-link"),
          ref: anchor?.getAttribute(LINK_KEPT_REF_ATTRIBUTE) ?? null,
        },
        row,
      )
      .toEqual(pasted);
  }

  // Plain text spells each link's current full address, never an id.
  const documentSchema = buildDocumentSchema();
  const resolution = createLinkAnswerCache();
  const answers: Record<string, LinkAnswer> = {
    [`doc:${MOVED}`]: {
      state: "document",
      document: {
        documentId: MOVED,
        title: "New",
        scheme: "manuscript",
        path: "vol-2/new.md",
        uri: "manuscript://vol-2/new.md",
        workId: null,
      },
    },
    [`doc:${GONE}`]: { state: "gone", document: null },
    [AHEAD]: { state: "missing", document: null },
  };
  resolution.registerResolver(
    {
      local: ({ ref }) => {
        const answer = ref ? answers[ref] : undefined;
        return answer ? { kind: "answered", answer } : { kind: "unasked" };
      },
      remote: async (questions) => questions.map(() => null),
    },
    { baseUri: "manuscript://vol-1/holder.md", projectId: "project-a" },
  );
  const textRows: [label: string, href: string, ref: string | null, spelled: string][] = [
    [
      "a moved doc link spells its new address",
      "manuscript://vol-1/old.md#s",
      `doc:${MOVED}`,
      "[Moved](manuscript://vol-2/new.md#s)",
    ],
    [
      "a gone link spells its stored address",
      "manuscript://vol-1/doomed.md",
      `doc:${GONE}`,
      "[Gone](manuscript://vol-1/doomed.md)",
    ],
    [
      "an ahead link spells its stored address",
      "manuscript://vol-1/later.md",
      AHEAD,
      "[Ahead](manuscript://vol-1/later.md)",
    ],
    [
      "a relative no-ref link is qualified",
      "sibling.md",
      null,
      "[Rel](manuscript://vol-1/sibling.md)",
    ],
  ];
  const words = ["Moved", "Gone", "Ahead", "Rel"];
  const paragraph = documentSchema.nodes.paragraph.create(
    null,
    textRows.flatMap(([, href, ref], at) => [
      ...(at ? [documentSchema.text(" ")] : []),
      documentSchema.text(words[at] ?? "", [documentSchema.marks.link.create({ href, ref })]),
    ]),
  );
  resolution.request(textRows.map(([, href, ref]) => ({ ref, href })));
  const doc = documentSchema.nodes.doc.create(null, paragraph);
  const state = EditorState.create({
    schema: documentSchema,
    doc,
    plugins: [linkClipboardPlugin(documentSchema, resolution)],
  });
  const text = markdownClipboardSerializer(new Slice(doc.content, 0, 0), { state } as never);
  for (const [label, , , spelled] of textRows) expect.soft(text, label).toContain(spelled);
  expect.soft(text, "no ref or id in plain text").not.toMatch(/doc:|ahead:|0000-4000/);
});

it.each([
  "javascript:alert(1)",
  "../forged.md",
  "manuscript://v/./forged.md",
])("a forged clipboard address %s cannot inject an href", (address) => {
  expect(
    paste(
      `<a data-meridian-link="original.md" data-meridian-address="${address}">x</a>`,
      "manuscript://base.md",
    ),
  ).toBe('<a data-meridian-link="original.md">x</a>');
});
