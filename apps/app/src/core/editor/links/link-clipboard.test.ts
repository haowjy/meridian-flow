// @vitest-environment jsdom
/**
 * Clipboard link metadata carries what a link names into the paste, keeps a
 * ref only inside its own project, and never injects an href.
 */
import { Schema } from "@tiptap/pm/model";
import { expect, it } from "vitest";
import { LINK_KEPT_REF_ATTRIBUTE, linkClipboardPlugin } from "./link-clipboard";
import { createLinkResolution } from "./link-resolution";

const schema = new Schema({
  nodes: { doc: { content: "text*" }, text: {} },
  marks: {
    link: {
      attrs: { href: {}, ref: { default: null } },
      toDOM: (mark) => ["a", { "data-meridian-link": mark.attrs.href }, 0],
    },
  },
});

function clipboard(holder: string | null, projectId = "project-a") {
  const resolution = createLinkResolution();
  resolution.registerResolver(async (questions) => questions.map(() => null), {
    baseUri: holder,
    projectId,
  });
  return linkClipboardPlugin(schema, resolution);
}

function paste(html: string, holder: string | null, projectId = "project-a") {
  const plugin = clipboard(holder, projectId);
  return plugin.props.transformPastedHTML?.call(plugin, html, null as never);
}

it.each([
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
    copied: { from: "manuscript://a/source.md", href: "manuscript://a/kael.md", ref: "doc:kael" },
    into: { holder: "manuscript://b/new.md", project: "project-a" },
    pasted: { link: "manuscript://a/kael.md", ref: "doc:kael" },
  },
  {
    row: "another project's paste drops the ref for a fresh binding",
    copied: { from: "manuscript://a/source.md", href: "manuscript://a/kael.md", ref: "doc:kael" },
    into: { holder: "manuscript://b/new.md", project: "project-b" },
    pasted: { link: "manuscript://a/kael.md", ref: null },
  },
])("$row", ({ copied, into, pasted }) => {
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
  expect({
    link: anchor?.getAttribute("data-meridian-link"),
    ref: anchor?.getAttribute(LINK_KEPT_REF_ATTRIBUTE) ?? null,
  }).toEqual(pasted);
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
