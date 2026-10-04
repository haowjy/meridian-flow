// @vitest-environment jsdom
/** Clipboard address metadata must preserve the target, never inject an href. */
import { Schema } from "@tiptap/pm/model";
import { expect, it } from "vitest";
import { linkClipboardPlugin } from "./link-clipboard";
import { createLinkResolution } from "./link-resolution";

const schema = new Schema({
  nodes: { doc: { content: "text*" }, text: {} },
  marks: {
    link: {
      attrs: { href: {} },
      toDOM: (mark) => ["a", { "data-meridian-link": mark.attrs.href }, 0],
    },
  },
});

function clipboard(holder: string | null) {
  const resolution = createLinkResolution();
  resolution.registerResolver(async () => null, { baseUri: holder });
  return linkClipboardPlugin(schema, resolution);
}

function paste(html: string, holder: string | null) {
  const plugin = clipboard(holder);
  return plugin.props.transformPastedHTML?.call(plugin, html, null as never);
}

it.each([
  ["manuscript://a/source.md", "target.md#scene", "manuscript://b/new.md", "../a/target.md#scene"],
  ["manuscript://a/source.md", "target.md", "kb://new.md", "manuscript://a/target.md"],
  ["manuscript://a/source.md", "target.md", null, "manuscript://a/target.md"],
  ["manuscript://a/source.md", "ch%233%25.md", "manuscript://b/new.md", "../a/ch%233%25.md"],
  [
    "scratch://@revision/notes/a.md",
    "scratch://plan.md",
    "scratch://@other/b.md",
    "scratch://@revision/plan.md",
  ],
])("re-spells a link copied from %s (%s) for %s", (source, href, holder, expected) => {
  const fragment = schema.node(
    "doc",
    null,
    schema.text("x", [schema.marks.link.create({ href })]),
  ).content;
  const copied = document.createElement("div");
  const serializer = clipboard(source).props.clipboardSerializer;
  if (!serializer) throw new Error("Missing clipboard serializer");
  copied.append(serializer.serializeFragment(fragment));
  const html = paste(copied.innerHTML, holder);
  const container = document.createElement("template");
  container.innerHTML = html ?? "";
  expect(container.content.querySelector("a")?.getAttribute("data-meridian-link")).toBe(expected);
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
