/**
 * meridian-extensions — the project's customized TipTap node/mark extensions.
 *
 * Subclasses the base TipTap nodes/marks (lists, code, link, image, hard
 * break, and the custom figure node with its React node view) to match the
 * Meridian ProseMirror schema and Warm Organic rendering. Owns the editor schema
 * surface; consumed by the editor `config`.
 */
import { mergeAttributes, Node, wrappingInputRule } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import Code from "@tiptap/extension-code";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import ListItem from "@tiptap/extension-list-item";
import OrderedList from "@tiptap/extension-ordered-list";
import Paragraph from "@tiptap/extension-paragraph";
import { Table, TableView } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { FigureNodeView, ImageNodeView } from "../FigureNodeView";
import { JsxContainerNodeView, JsxLeafNodeView } from "../JsxNodeViews";
import { MermaidCodeBlockNodeView } from "../MermaidCodeBlock";

type RenderAttrs = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePropsAttr(value: string | null): JsonRecord {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function renderPropsAttr(value: unknown): string {
  return JSON.stringify(isJsonRecord(value) ? value : {});
}

function tableCellAttributes(parentAttrs: (() => Record<string, unknown>) | undefined) {
  const attrs: Record<string, unknown> = { ...(parentAttrs?.() ?? {}) };
  delete attrs.align;

  return {
    alignment: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const value = element.style.textAlign;
        return value === "left" || value === "center" || value === "right" ? value : null;
      },
      renderHTML: (attrs: RenderAttrs) =>
        attrs.alignment === "left" || attrs.alignment === "center" || attrs.alignment === "right"
          ? { style: `text-align: ${attrs.alignment}` }
          : {},
    },
    ...attrs,
  };
}

/** Block alignment attrs mirroring the shared schema's `Layout` wire wrapper. */
function textLayoutAttributes() {
  return {
    align: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const value = element.style.textAlign;
        return value === "center" || value === "right" ? value : null;
      },
      renderHTML: (attrs: RenderAttrs) =>
        attrs.align === "center" || attrs.align === "right"
          ? { style: `text-align: ${attrs.align}` }
          : {},
    },
  };
}

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

export const MeridianParagraph = Paragraph.extend({
  addAttributes: textLayoutAttributes,
});

export const MeridianHeading = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), ...textLayoutAttributes() };
  },
});

export const MeridianListItem = ListItem.extend({
  name: "list_item",

  addAttributes() {
    return {
      checked: {
        default: null,
        parseHTML: (element) => {
          const checkbox = element.querySelector('input[type="checkbox"]');
          return checkbox ? (checkbox as HTMLInputElement).checked : null;
        },
        renderHTML: (attrs) =>
          attrs.checked === null ? {} : { "data-checked": attrs.checked ? "true" : "false" },
      },
    };
  },
});

// One node view for every fence. A `mermaid` fence renders as a diagram and
// hides its own `<pre>`; every other language is the fence itself, lowlight and
// all. The hazard that once kept this unregistered — a caret in a hidden
// element silently eating keystrokes — is answered inside the view: the source
// comes back whenever a caret is in it (interaction model §5.2).
export const MeridianCodeBlockLowlight = CodeBlockLowlight.extend({
  name: "code_block",

  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockNodeView);
  },

  // The fence trigger belongs to `MarkdownAutoformatExtension`, which accepts
  // the whole GFM info string and completes on Enter. Keeping TipTap's narrower
  // rules here would leave two rules racing for the same keystrokes.
  addInputRules() {
    return [];
  },
});

/** Keeps block alignment live when the resize plugin takes over table rendering. */
export class MeridianTableView extends TableView {
  constructor(...args: ConstructorParameters<typeof TableView>) {
    super(...args);
    this.applyAlignment(args[0]);
  }

  override update(node: ProseMirrorNode): boolean {
    if (!super.update(node)) return false;
    if (!this.hasColumnWidths(node)) {
      for (const column of this.colgroup.children) {
        (column as HTMLElement).style.removeProperty("width");
      }
    }
    this.applyAlignment(node);
    return true;
  }

  private hasColumnWidths(node: ProseMirrorNode): boolean {
    let hasWidth = false;
    node.descendants((child) => {
      if (Array.isArray(child.attrs.colwidth) && child.attrs.colwidth.some(Boolean)) {
        hasWidth = true;
        return false;
      }
      return !hasWidth;
    });
    return hasWidth;
  }

  private applyAlignment(node: ProseMirrorNode) {
    const alignment = node.attrs.align;
    if (alignment === "center" || alignment === "right") {
      this.table.dataset.align = alignment;
      this.table.style.marginLeft = "auto";
      this.table.style.marginRight = alignment === "center" ? "auto" : "0px";
      return;
    }
    delete this.table.dataset.align;
    this.table.style.marginLeft = "";
    this.table.style.marginRight = "";
  }
}

export const MeridianTable = Table.extend({
  name: "table",
  content: "table_row+",

  addAttributes() {
    return {
      align: {
        default: null,
        parseHTML: (element) => {
          const value = element.dataset.align;
          return value === "center" || value === "right" ? value : null;
        },
        renderHTML: (attrs) => {
          if (attrs.align === "center") {
            return { "data-align": "center", style: "margin-left: auto; margin-right: auto" };
          }
          if (attrs.align === "right") {
            return { "data-align": "right", style: "margin-left: auto; margin-right: 0" };
          }
          return {};
        },
      },
    };
  },
}).configure({ resizable: true, View: MeridianTableView });

export const MeridianTableRow = TableRow.extend({
  name: "table_row",
  content: "(table_header | table_cell)+",
});

export const MeridianTableHeader = TableHeader.extend({
  name: "table_header",
  content: "paragraph",

  addAttributes() {
    return tableCellAttributes(this.parent);
  },
});

export const MeridianTableCell = TableCell.extend({
  name: "table_cell",
  content: "paragraph",

  addAttributes() {
    return tableCellAttributes(this.parent);
  },
});

// ─── Customized extensions ──────────────────────────────────────────
// Extensions that add behavior beyond what TipTap defaults provide.

export const MeridianLink = Link.extend({
  inclusive: false,

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        props: {
          handleDOMEvents: {
            // An editable link click must place a cursor, not navigate away
            // from the manuscript. Returning false still lets ProseMirror
            // handle the selection.
            click: (view, event) => {
              if (!view.editable) return false;
              const target = event.target;
              if (!(target instanceof Element)) return false;
              const link = target.closest("a");
              if (!link || !view.dom.contains(link)) return false;
              event.preventDefault();
              return false;
            },
          },
        },
      }),
    ];
  },

  addAttributes() {
    return {
      href: { default: "" },
      title: { default: null },
    };
  },
}).configure({ openOnClick: false });

// We renamed list_item from TipTap's default `listItem`, so the list commands
// (toggleBulletList / toggleOrderedList) must be pointed at the renamed item type
// via `itemTypeName` — otherwise they resolve "listItem", which isn't in the
// schema, and throw.
/** Markdown list tightness is a serialization fact, never a DOM attribute. */
const tightAttribute = { default: false, renderHTML: () => ({}) };

export const MeridianBulletList = BulletList.extend({
  name: "bullet_list",
  content: "list_item+",
  group: "block",

  addAttributes() {
    return {
      tight: tightAttribute,
    };
  },
}).configure({ itemTypeName: "list_item" });

export const MeridianOrderedList = OrderedList.extend({
  name: "ordered_list",
  content: "list_item+",
  group: "block",

  addAttributes() {
    return {
      // GFM's list start number. TipTap calls it `start`; the shared schema
      // calls it `order`, so the rename has to reach the DOM mapping and the
      // input rule below as well as the attr itself — an inherited `start`
      // silently falls out of the schema, and the writer's `3. ` opens at one.
      order: {
        default: 1,
        parseHTML: (element) => {
          const start = Number.parseInt(element.getAttribute("start") ?? "", 10);
          return Number.isFinite(start) ? start : 1;
        },
        renderHTML: (attrs) =>
          typeof attrs.order === "number" && attrs.order !== 1 ? { start: attrs.order } : {},
      },
      tight: tightAttribute,
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^(\d+)\.\s$/,
        type: this.type,
        getAttributes: (match) => ({ order: Number(match[1]) }),
        joinPredicate: (match, node) => node.childCount + Number(node.attrs.order) === +match[1],
      }),
    ];
  },
}).configure({ itemTypeName: "list_item" });

export const MeridianImage = Image.extend<ImageOptions & { projectId?: string }>({
  marks: "",

  addOptions() {
    const parent = this.parent?.();
    if (!parent) throw new Error("MeridianImage requires the base image options");
    return { ...parent, projectId: undefined };
  },

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: null },
      title: { default: null },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
}).configure({ inline: true, allowBase64: true });

// ─── Meridian-only extensions ─────────────────────────────────────────
// Node types not in TipTap's standard library.
// TODO: figure — needs full MyST directive support, currently renders via FigureNodeView

export const MeridianJsxLeaf = Node.create({
  name: "jsx_leaf",
  group: "block",
  content: "text*",
  code: true,

  addAttributes() {
    return {
      name: {
        default: undefined,
        isRequired: true,
        parseHTML: (element) => element.getAttribute("data-name"),
        renderHTML: (attrs) => ({
          "data-name": typeof attrs.name === "string" ? attrs.name : "",
        }),
      },
      props: {
        default: {},
        parseHTML: (element) => parsePropsAttr(element.getAttribute("data-props")),
        renderHTML: (attrs) => ({
          "data-props": renderPropsAttr(attrs.props),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-type='jsx_leaf']" }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(JsxLeafNodeView);
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "jsx_leaf" }),
      ["span", { "data-role": "jsx-leaf-content" }, 0],
    ];
  },
});

export const MeridianJsxContainer = Node.create({
  name: "jsx_container",
  group: "block",
  content: "block+",

  addAttributes() {
    return {
      name: {
        default: undefined,
        isRequired: true,
        parseHTML: (element) => element.getAttribute("data-name"),
        renderHTML: (attrs) => ({
          "data-name": typeof attrs.name === "string" ? attrs.name : "",
        }),
      },
      props: {
        default: {},
        parseHTML: (element) => parsePropsAttr(element.getAttribute("data-props")),
        renderHTML: (attrs) => ({
          "data-props": renderPropsAttr(attrs.props),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-type='jsx_container']" }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(JsxContainerNodeView);
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "jsx_container" }), 0];
  },
});

export const MeridianFigure = Node.create<{ projectId?: string }>({
  name: "figure",
  group: "block",
  atom: true,
  defining: true,
  // Not draggable: PM default DnD reorders in place, which re-binds block hashes
  // (y-prosemirror reconciles by slot). Figure drag-to-place must be reimplemented
  // as delete+insert — see .context/TODO.md.

  addOptions() {
    return {
      projectId: undefined,
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
