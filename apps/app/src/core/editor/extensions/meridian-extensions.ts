/**
 * meridian-extensions — the project's customized TipTap node/mark extensions.
 *
 * Subclasses the base TipTap nodes/marks (lists, code, link, image, hard
 * break, and the custom figure node with its React node view) to match the
 * Meridian ProseMirror schema and Warm Organic rendering. Owns the editor schema
 * surface; consumed by the editor `config`.
 */
import { mergeAttributes, Node } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import Code from "@tiptap/extension-code";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import HardBreak from "@tiptap/extension-hard-break";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Image from "@tiptap/extension-image";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import ListItem from "@tiptap/extension-list-item";
import OrderedList from "@tiptap/extension-ordered-list";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { FigureNodeView } from "../FigureNodeView";

type RenderAttrs = Record<string, unknown>;

// ─── Name-parity renames ────────────────────────────────────────────
// TipTap uses camelCase names; our shared ProseMirror schema uses snake_case.
// These renames are required for Yjs CRDT compatibility — node type names
// must match exactly between the server schema and TipTap's schema.

export const MeridianStrong = Bold.extend({
  name: "strong",
});

export const MeridianEm = Italic.extend({
  name: "em",
});

export const MeridianCode = Code.extend({
  name: "code",
});

export const MeridianHardBreak = HardBreak.extend({
  name: "hard_break",
});

export const MeridianHorizontalRule = HorizontalRule.extend({
  name: "horizontal_rule",
});

export const MeridianListItem = ListItem.extend({
  name: "list_item",
});

export const MeridianCodeBlockLowlight = CodeBlockLowlight.extend({
  name: "code_block",
});

// ─── Customized extensions ──────────────────────────────────────────
// Extensions that add behavior beyond what TipTap defaults provide.

export const MeridianLink = Link.extend({
  inclusive: false,

  addAttributes() {
    return {
      href: { default: "" },
      title: { default: null },
    };
  },
});

export const MeridianBulletList = BulletList.extend({
  name: "bullet_list",
  content: "list_item+",
  group: "block",

  addAttributes() {
    return {
      tight: { default: false },
    };
  },
});

export const MeridianOrderedList = OrderedList.extend({
  name: "ordered_list",
  content: "list_item+",
  group: "block",

  addAttributes() {
    return {
      order: { default: 1 },
      tight: { default: false },
    };
  },
});

export const MeridianImage = Image.extend({
  marks: "",

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: null },
      title: { default: null },
    };
  },
}).configure({ inline: true });

// ─── Meridian-only extensions ─────────────────────────────────────────
// Node types not in TipTap's standard library.
// TODO: figure — needs full MyST directive support, currently renders via FigureNodeView

export const MeridianFigure = Node.create<{ projectId?: string; documentId?: string }>({
  name: "figure",
  group: "block",
  atom: true,
  defining: true,
  draggable: true,

  addOptions() {
    return {
      projectId: undefined,
      documentId: undefined,
    };
  },

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: null },
      label: { default: null },
      caption: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "figure[data-type='figure']",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const image = node.querySelector("img");
          const caption = node.querySelector("figcaption")?.textContent ?? "";
          return {
            src: image?.getAttribute("src") ?? "",
            alt: image?.getAttribute("alt"),
            label: node.getAttribute("data-label"),
            caption,
          };
        },
      },
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureNodeView);
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as RenderAttrs;
    const src = typeof attrs.src === "string" ? attrs.src : "";
    const alt = typeof attrs.alt === "string" ? attrs.alt : null;
    const label = typeof attrs.label === "string" ? attrs.label : null;
    const caption = typeof attrs.caption === "string" ? attrs.caption : "";

    return [
      "figure",
      mergeAttributes(HTMLAttributes, { "data-type": "figure", "data-label": label }),
      ["img", { src, alt }],
      ["figcaption", caption],
    ];
  },
});
