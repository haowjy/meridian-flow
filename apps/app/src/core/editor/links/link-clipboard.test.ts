// @vitest-environment jsdom
/**
 * Clipboard link metadata carries what a link or picture names into the
 * paste, keeps a ref only inside its own project, and never injects an href;
 * plain text spells current full addresses and never an id.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Editor, type JSONContent } from "@tiptap/core";
import { Schema, Slice } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { registerImageIngressHost } from "../images/image-ingress-runtime";
import { insertImageFile } from "../images/image-uploads";
import { markdownClipboardSerializer } from "../markdown-paste";
import { sanitizePastedHTML } from "../sanitize-paste";
import { clipboardLinkScope, LINK_KEPT_REF_ATTRIBUTE, linkClipboardPlugin } from "./link-clipboard";
import { createLinkAnswerCache, type LinkAnswer } from "./link-resolution";
import { LINK_SURFACE_NAME } from "./link-storage";

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
const PICTURE = "00000000-0000-4000-8000-0000000000c1";

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

it("carries what a copied link names across the clipboard", async () => {
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
      row: "a contextual Scratch link carries its lineage",
      copied: { from: "scratch://@/c12/holder.md", href: "scratch://note.md#gate", ref: null },
      into: { holder: "manuscript://chapter.md", project: "project-a" },
      pasted: { link: "scratch://@/c12/note.md#gate", ref: null },
    },
    {
      row: "Uploads in a lineage holder remain No Work owned",
      copied: { from: "scratch://@/c12/holder.md", href: "uploads://seal.md", ref: null },
      into: { holder: "manuscript://chapter.md", project: "project-a" },
      pasted: { link: "uploads://@/seal.md", ref: null },
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
    [`doc:${PICTURE}`]: {
      state: "document",
      document: {
        documentId: PICTURE,
        title: "new",
        scheme: "manuscript",
        path: "art/new.png",
        uri: "manuscript://art/new.png",
        workId: null,
      },
    },
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
  // A picture spells its source as rich copy records it: the answered
  // document's current address (manuscript-root grammar, suffix kept), the
  // stored source for a gone or missing answer, and no source at all for an
  // upload the catalog does not hold (its id is never text).
  const pictureTextRows: [label: string, src: string, ref: string | null, spelled: string][] = [
    [
      "a moved image spells its new address",
      "manuscript://art/old.png#crop",
      `doc:${PICTURE}`,
      "![](art/new.png#crop)",
    ],
    [
      "a gone image spells its stored source",
      "manuscript://art/doomed.png",
      `doc:${GONE}`,
      "![](manuscript://art/doomed.png)",
    ],
    [
      "a missing image spells its stored source",
      "manuscript://art/later.png",
      AHEAD,
      "![](manuscript://art/later.png)",
    ],
    [
      "an upload the catalog does not hold spells an empty source",
      "asset:5f0c9a1e-2b3d-4c5e-8f9a-0b1c2d3e4f5a",
      null,
      "![]()",
    ],
  ];
  const pictures = documentSchema.nodes.paragraph.create(
    null,
    pictureTextRows.map(([, src, ref]) => documentSchema.nodes.image.create({ src, ref })),
  );
  const figure = documentSchema.nodes.figure.create({
    src: "manuscript://art/old.png",
    ref: `doc:${PICTURE}`,
    caption: "Plate",
  });
  resolution.request([
    ...[...textRows, ...pictureTextRows].map(([, href, ref]) => ({ ref, href })),
    { ref: `doc:${PICTURE}`, href: "manuscript://art/old.png" },
  ]);
  const doc = documentSchema.nodes.doc.create(null, [paragraph, pictures, figure]);
  const state = EditorState.create({
    schema: documentSchema,
    doc,
    plugins: [linkClipboardPlugin(documentSchema, resolution)],
  });
  const text = markdownClipboardSerializer(new Slice(doc.content, 0, 0), { state } as never);
  for (const [label, , , spelled] of [...textRows, ...pictureTextRows])
    expect.soft(text, label).toContain(spelled);
  expect.soft(text, "the figure fallback spells its new address").toContain('src="art/new.png"');
  expect
    .soft(text, "no ref or id in plain text")
    .not.toMatch(/doc:|ahead:|asset:|0000-4000|5f0c9a1e/);

  // Pictures, through a real editor's whole copy and paste: the serializer,
  // the sanitizer, the ref transform, the TipTap mirrors and the one paste
  // assignment.
  const MAP = "00000000-0000-4000-8000-0000000000b1";
  const OTHER_MAP = "00000000-0000-4000-8000-0000000000b2";
  const SETTLED = "ahead:00000000-0000-4000-8000-0000000000b3";
  const PLATE_REF = "doc:00000000-0000-4000-8000-0000000000b4";
  const pictureEditor = (
    projectId: string,
    documents: { documentId: string; uri: string }[],
    content: JSONContent[] = [{ type: "paragraph" }],
  ) => {
    const editor = new Editor({
      extensions: createStandaloneEditorExtensions({ assetRenderContext: { projectId } }),
      content: { type: "doc", content },
      // The app's paste sanitizer runs before every plugin transform.
      editorProps: { transformPastedHTML: sanitizePastedHTML },
    });
    const settled: Record<string, LinkAnswer> = {
      [SETTLED]: {
        state: "document",
        document: {
          documentId: MAP,
          title: "map",
          scheme: "manuscript",
          path: "uploads/map.png",
          uri: "manuscript://uploads/map.png",
          workId: null,
        },
      },
    };
    editor.storage[LINK_SURFACE_NAME].resolution.registerResolver(
      {
        index: { documents },
        local: ({ ref }) => {
          const answer = ref ? settled[ref] : undefined;
          return answer ? { kind: "answered", answer } : { kind: "unasked" };
        },
        remote: async (questions) => questions.map(() => null),
      },
      { baseUri: "manuscript://vol-1/holder.md", projectId },
    );
    return editor;
  };
  const source = pictureEditor(
    "project-a",
    [],
    [
      {
        type: "paragraph",
        content: [{ type: "image", attrs: { src: "manuscript://art/map.png", ref: SETTLED } }],
      },
      {
        type: "figure",
        attrs: { src: "manuscript://art/plate.png", ref: PLATE_REF, caption: "Plate" },
      },
    ],
  );
  source.storage[LINK_SURFACE_NAME].resolution.request([
    { ref: SETTLED, href: "manuscript://art/map.png" },
  ]);
  const serialized = source.view.serializeForClipboard(source.state.doc.slice(0));
  const copied = { html: serialized.dom.innerHTML };
  // An upload is stored as `asset:<id>`; the clipboard carries it as the
  // catalog's current address for that id, like any ref-bearing picture.
  const UPLOAD = "00000000-0000-4000-8000-0000000000b5";
  const uploadSource = pictureEditor(
    "project-a",
    [{ documentId: UPLOAD, uri: "manuscript://art/new.png" }],
    [{ type: "paragraph", content: [{ type: "image", attrs: { src: `asset:${UPLOAD}` } }] }],
  );
  const uploadSerialized = uploadSource.view.serializeForClipboard(uploadSource.state.doc.slice(0));
  uploadSource.destroy();
  // A completed upload copied before the catalog holds it: the clipboard
  // carries its recorded `asset:` identity with no address (decision L42).
  const early = pictureEditor("project-a", []);
  registerImageIngressHost(early, {
    upload: async () => ({ src: `asset:${UPLOAD}`, alt: null }),
    fetchBytes: async () => null,
  });
  insertImageFile(early, new File(["png"], "new.png", { type: "image/png" }), 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const earlyCopied = {
    html: early.view.serializeForClipboard(early.state.doc.slice(0)).dom.innerHTML,
  };
  const earlyFigure = pictureEditor(
    "project-a",
    [],
    [{ type: "figure", attrs: { src: `asset:${UPLOAD}`, caption: "Plate" } }],
  );
  const earlyFigureCopied = {
    html: earlyFigure.view.serializeForClipboard(earlyFigure.state.doc.slice(0)).dom.innerHTML,
  };
  earlyFigure.destroy();
  // Escaping, root-relative and malformed spellings are no web URL either:
  // in an `<img src>` they would be fetched from the app's own origin.
  const unusableSources = ["../map.png", "art/../../map.png", "/map.png", "ASSET:abc", "asset:"];
  const unusable = pictureEditor(
    "project-a",
    [],
    [
      {
        type: "paragraph",
        content: unusableSources.map((src) => ({ type: "image", attrs: { src } })),
      },
      ...unusableSources.map((src) => ({ type: "figure", attrs: { src, caption: "Plate" } })),
    ],
  );
  const unusableCopied = unusable.view.serializeForClipboard(unusable.state.doc.slice(0)).dom
    .innerHTML;
  unusable.destroy();
  // A stored source is never a browser URL: the copy names its picture in the
  // metadata, and an `<img src>` the clipboard serializer builds is fetched.
  for (const [label, html] of [
    ["ref pictures", copied.html],
    ["an upload", uploadSerialized.dom.innerHTML],
    ["an early upload", earlyCopied.html],
    ["an early upload figure", earlyFigureCopied.html],
    ["escaping, root-relative and malformed sources", unusableCopied],
  ])
    expect.soft(html, `${label}: no fetchable source`).not.toMatch(/\ssrc=/);
  const pictureRows: {
    row: string;
    copied: { html: string } | { text: string };
    into: Editor;
    pasted: unknown[];
  }[] = [
    {
      row: "a same-project paste keeps each picture's ref at its current address",
      copied,
      into: pictureEditor("project-a", []),
      pasted: [
        { type: "image", src: "manuscript://uploads/map.png", ref: SETTLED },
        { type: "figure", src: "manuscript://art/plate.png", ref: PLATE_REF, caption: "Plate" },
      ],
    },
    {
      row: "another project binds each picture fresh, by its own index",
      copied,
      into: pictureEditor("project-b", [
        { documentId: OTHER_MAP, uri: "manuscript://uploads/map.png" },
      ]),
      pasted: [
        { type: "image", src: "manuscript://uploads/map.png", ref: `doc:${OTHER_MAP}` },
        {
          type: "figure",
          src: "manuscript://art/plate.png",
          ref: expect.stringMatching(/^ahead:/),
          caption: "Plate",
        },
      ],
    },
    {
      // The text spells the settled picture where it is now, so a Markdown-only
      // paste binds the same document, not whatever took its old address.
      row: "a Markdown-only paste binds the picture at its current address",
      copied: { text: serialized.text.split("\n\n")[0] ?? "" },
      into: pictureEditor("project-a", [
        { documentId: MAP, uri: "manuscript://uploads/map.png" },
        { documentId: OTHER_MAP, uri: "manuscript://art/map.png" },
      ]),
      pasted: [{ type: "image", src: "manuscript://uploads/map.png", ref: `doc:${MAP}` }],
    },
    {
      // Outside HTML naming a document address carries no metadata: it is
      // assigned fresh, exactly as its bare-path spelling is.
      row: "a metadata-free internal <img> is assigned fresh",
      copied: {
        html:
          '<p><img src="manuscript://uploads/map.png"><img src="uploads/map.png">' +
          '<img src="uploads://seal.png"><img src="manuscript://art/\u0001x.png">' +
          '<img src="javascript:alert(1)"></p>',
      },
      into: pictureEditor("project-b", [
        { documentId: OTHER_MAP, uri: "manuscript://uploads/map.png" },
      ]),
      pasted: [
        { type: "image", src: "manuscript://uploads/map.png", ref: `doc:${OTHER_MAP}` },
        { type: "image", src: "manuscript://uploads/map.png", ref: `doc:${OTHER_MAP}` },
        // Contextual: no ref to bind, so it stays a picture resolved by address.
        { type: "image", src: "uploads://seal.png", ref: null },
      ],
    },
    {
      row: "a same-project paste restores an upload's asset: ref",
      copied: { html: uploadSerialized.dom.innerHTML },
      into: pictureEditor("project-a", []),
      pasted: [{ type: "image", src: `asset:${UPLOAD}`, ref: null }],
    },
    {
      row: "an upload copied before the catalog holds it pastes back into its own editor",
      copied: earlyCopied,
      into: early,
      pasted: [
        { type: "image", src: `asset:${UPLOAD}`, ref: null },
        { type: "image", src: `asset:${UPLOAD}`, ref: null },
      ],
    },
    {
      row: "an upload copied before the catalog holds it pastes into another same-project editor",
      copied: earlyCopied,
      into: pictureEditor("project-a", []),
      pasted: [{ type: "image", src: `asset:${UPLOAD}`, ref: null }],
    },
    {
      // No address was recorded, so another project has nothing to bind.
      row: "an upload copied before the catalog holds it is not pasted into another project",
      copied: earlyCopied,
      into: pictureEditor("project-b", [
        { documentId: OTHER_MAP, uri: "manuscript://art/new.png" },
      ]),
      pasted: [],
    },
    {
      row: "an early upload figure keeps its asset: ref and caption in its project",
      copied: earlyFigureCopied,
      into: pictureEditor("project-a", []),
      pasted: [{ type: "figure", src: `asset:${UPLOAD}`, ref: null, caption: "Plate" }],
    },
    {
      // The figure is one picture: rejecting its image rejects the figure.
      row: "an early upload figure is not pasted into another project",
      copied: earlyFigureCopied,
      into: pictureEditor("project-b", [
        { documentId: OTHER_MAP, uri: "manuscript://art/new.png" },
      ]),
      pasted: [],
    },
    {
      row: "another project binds an upload fresh at its current address",
      copied: { html: uploadSerialized.dom.innerHTML },
      into: pictureEditor("project-b", [
        { documentId: OTHER_MAP, uri: "manuscript://art/new.png" },
      ]),
      pasted: [{ type: "image", src: "manuscript://art/new.png", ref: `doc:${OTHER_MAP}` }],
    },
    {
      row: "a Markdown-only paste binds an upload at its current address",
      copied: { text: uploadSerialized.text },
      into: pictureEditor("project-a", [{ documentId: UPLOAD, uri: "manuscript://art/new.png" }]),
      pasted: [{ type: "image", src: "manuscript://art/new.png", ref: `doc:${UPLOAD}` }],
    },
    {
      // The upload has moved on from `old.png`: the address is empty now, so
      // it is assigned fresh rather than naming the upload that used to be there.
      row: "a source the catalog holds no upload at is assigned fresh",
      copied: { text: "![](art/old.png)" },
      into: pictureEditor("project-a", [{ documentId: UPLOAD, uri: "manuscript://art/new.png" }]),
      pasted: [
        { type: "image", src: "manuscript://art/old.png", ref: expect.stringMatching(/^ahead:/) },
      ],
    },
  ];
  try {
    for (const { row, copied: clip, into, pasted } of pictureRows) {
      if ("html" in clip) into.view.pasteHTML(clip.html, new Event("paste") as ClipboardEvent);
      else {
        // A real paste event: `pasteText` would ask for plain characters.
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: { getData: (type: string) => (type === "text/plain" ? clip.text : "") },
        });
        into.view.dom.dispatchEvent(event);
      }
      const pictures: unknown[] = [];
      into.state.doc.descendants((node) => {
        if (node.type.name === "image" || node.type.name === "figure")
          pictures.push({
            type: node.type.name,
            src: node.attrs.src,
            ref: node.attrs.ref,
            ...(node.type.name === "figure" && { caption: node.attrs.caption }),
          });
      });
      expect.soft(pictures, row).toEqual(pasted);
      // Never a link standing in for a picture, nor an import of an address.
      expect.soft(into.getHTML(), `${row}: no stand-in link`).not.toContain("<a ");
      into.destroy();
    }
  } finally {
    source.destroy();
  }
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

it("qualifies plain-text Scratch and Uploads without confusing their owners", () => {
  const state = EditorState.create({ schema, plugins: [clipboard("scratch://@/c12/holder.md")] });
  const scope = clipboardLinkScope(state);
  expect(scope.spellLink({ ref: null, href: "scratch://note.md#gate" }).href).toBe(
    "scratch://@/c12/note.md#gate",
  );
  expect(scope.spellLink({ ref: null, href: "uploads://seal.md" }).href).toBe(
    "uploads://@/seal.md",
  );
});
