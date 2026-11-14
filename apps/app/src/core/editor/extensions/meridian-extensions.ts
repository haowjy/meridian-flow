/**
 * meridian-extensions — the project's customized TipTap node/mark extensions.
 *
 * Subclasses the base TipTap nodes/marks (lists, code, link, image, hard
 * break, and the custom figure node with its React node view) to match the
 * Meridian ProseMirror schema and Warm Organic rendering. Owns the editor schema
 * surface; consumed by the editor `config`.
 */
import {
  isiOS,
  isMacOS,
  type KeyboardShortcutCommand,
  mergeAttributes,
  Node,
  textblockTypeInputRule,
} from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import HardBreak from "@tiptap/extension-hard-break";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import Image, { type ImageOptions } from "@tiptap/extension-image";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";
import { Table, TableView } from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import {
  DOMSerializer,
  type Node as ProseMirrorNode,
  type ResolvedPos,
  Slice,
} from "@tiptap/pm/model";
import { Plugin, Selection } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CodeBlockNodeView } from "../CodeBlockNodeView";
import { FigureNodeView } from "../FigureNodeView";
import { ImageNodeView } from "../images/ImageNodeView";
import { imageDragPreviewPlugin } from "../images/image-drag-preview";
import { IMAGE_WIDTH_ATTRIBUTE } from "../images/image-resize";
import { browserPictureSource } from "../images/image-workflow";
import { pendingImageSignature, UPLOAD_TOKEN_ATTRIBUTE } from "../images/pending-images";
import { JsxContainerNodeView, JsxLeafNodeView } from "../JsxNodeViews";
import { cellInteriorPressPlugin } from "../landing/cell-interior-press";
import { clipboardLinkRef, LINK_KEPT_REF_ATTRIBUTE } from "../links/link-clipboard";
import { drawLinkAnswer } from "../links/link-mark-view";
import { mountedLinks } from "../links/link-storage";
import {
  classifyLinkTarget,
  internalClipboardTarget,
  isInternalLinkTarget,
  linkTargetHref,
  normalizeLinkHref,
} from "../links/link-target";
import { objectSelectedInDecorations } from "../objects";
import { tableSweepPastePlugin } from "../table-sweep-paste";
import { landSlice } from "./nesting";

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

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    heading: {
      /** Sets the level of the blocks under the selection, keeping their elements. */
      setHeading: (attributes: { level: HeadingLevel }) => ReturnType;
      /** Sets the level, or returns the blocks to body text when they already have it. */
      toggleHeading: (attributes: { level: HeadingLevel }) => ReturnType;
    };
  }
}

const HEADING_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

const unclosed = new WeakMap<Slice, Slice>();

/**
 * ProseMirror lets a pasted node replace the block it lands in, instead of
 * merging into it, when the pasted node type is `defining`. That is a flag on
 * the type, and a heading is no longer a type: closing the slice's open start
 * for a leveled paragraph gives replaceRange the same input a `defining`
 * heading gave it. A list item replaces only an empty line, so a list pasted
 * there keeps its first item. A destination with the same attributes still
 * takes the content in place, as `defining` also lets it.
 */
function closeShapedSlice(slice: Slice, $dest: ResolvedPos): Slice {
  const first = slice.content.firstChild;
  const replaces =
    first?.attrs.level != null ||
    (first?.attrs.path != null && $dest.parent.isTextblock && $dest.parent.content.size === 0);
  if (
    slice.openStart !== 1 ||
    first?.type.name !== "paragraph" ||
    !replaces ||
    first.sameMarkup($dest.parent)
  ) {
    return slice;
  }
  return new Slice(slice.content, 0, slice.openEnd);
}

function shapeForDestination(slice: Slice, $dest: ResolvedPos): Slice {
  return closeShapedSlice(landSlice(slice, $dest), $dest);
}

/** A slice shaped for the block it will land in, whatever shaping the paste hook already gave it. */
export function sliceForDestination(slice: Slice, $dest: ResolvedPos): Slice {
  return shapeForDestination(unclosed.get(slice) ?? slice, $dest);
}

/**
 * A heading is a paragraph with a `level` (null is body text). One node name
 * means retyping a block edits its Yjs element in place instead of rebuilding
 * it, so a peer's concurrent typing, authorship and anchors in it survive.
 */
export const MeridianParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...textLayoutAttributes(),
      level: {
        default: null,
        // Enter at the end of a heading starts body text.
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => {
          const match = /^H([1-6])$/.exec(element.tagName);
          return match ? Number(match[1]) : null;
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "p" }, ...HEADING_LEVELS.map((level) => ({ tag: `h${level}` }))];
  },

  renderHTML({ node, HTMLAttributes }) {
    const tag = node.attrs.level === null ? "p" : `h${node.attrs.level}`;
    return [tag, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      // The stock command keeps the block's current attrs, level included.
      setParagraph:
        () =>
        ({ commands }) =>
          commands.setNode(this.name, { level: null }),
      setHeading:
        ({ level }) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, { level }),
      toggleHeading:
        ({ level }) =>
        ({ commands, editor }) =>
          commands.updateAttributes(this.name, {
            level: editor.isActive(this.name, { level }) ? null : level,
          }),
    };
  },

  addKeyboardShortcuts() {
    // TipTap's Backspace clears a first empty block's type only when its node is
    // not named `paragraph`, which now includes headings. The same condition, on
    // every key TipTap's keymap routes to that one handler. Undoing the autoformat
    // rule just applied comes first, and is not ours.
    const clearFirstEmptyLevel: KeyboardShortcutCommand = ({ editor }) =>
      editor.commands.command(({ tr, commands }) => {
        if (editor.can().undoInputRule()) return false;
        const { empty, $anchor } = tr.selection;
        const { parent: block, pos } = $anchor;
        if (!empty || block.type !== this.type || block.attrs.level === null || block.textContent) {
          return false;
        }
        const $parentPos = pos > 0 ? tr.doc.resolve(pos - 1) : $anchor;
        const isolated =
          $parentPos.parent.type.spec.isolating && $parentPos.parent.childCount === 1;
        const atStart = isolated
          ? $anchor.pos - $anchor.parentOffset === pos
          : Selection.atStart(tr.doc).from === pos;
        return atStart && commands.updateAttributes(this.name, { level: null });
      });
    const backspaceKeys = ["Backspace", "Mod-Backspace", "Shift-Backspace"];
    if (isMacOS() || isiOS()) backspaceKeys.push("Ctrl-h", "Alt-Backspace");
    return {
      ...this.parent?.(),
      ...Object.fromEntries(backspaceKeys.map((key) => [key, clearFirstEmptyLevel])),
      ...Object.fromEntries(
        HEADING_LEVELS.map((level) => [
          `Mod-Alt-${level}`,
          () => this.editor.commands.toggleHeading({ level }),
        ]),
      ),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // A paste lands at the selection. A drop is shaped again where it lands
          // (`slice-drop.ts`), from the slice as it was before this ran.
          transformPasted: (slice, view) => {
            const shaped = shapeForDestination(slice, view.state.selection.$from);
            if (shaped !== slice) unclosed.set(shaped, slice);
            return shaped;
          },
        },
      }),
    ];
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^(#{1,6})\s$/,
        type: this.type,
        getAttributes: (match) => ({ level: match[1]?.length }),
      }),
    ];
  },
});

// One node view for every fence. A fence whose language a diagram provider
// claims renders as a diagram and hides its own `<pre>` (the catalog decides
// which, `../diagrams/diagram-providers.ts`); every other language is the fence
// itself, lowlight and all. The hazard that once kept this unregistered — a
// caret in a hidden element silently eating keystrokes — is answered inside the
// view: the source comes back whenever a caret is in it (interaction model §5.2).
export const MeridianCodeBlockLowlight = CodeBlockLowlight.extend({
  name: "code_block",

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },

  // The fence trigger belongs to `MarkdownAutoformatExtension`, which accepts
  // the whole GFM info string and completes on Enter. Keeping TipTap's narrower
  // rules here would leave two rules racing for the same keystrokes.
  addInputRules() {
    return [];
  },
});

/** Keeps block alignment live when the resize plugin takes over table rendering. */
class MeridianTableView extends TableView {
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

  // Before the parent's, so the sweep-replace paste answers ahead of
  // prosemirror-tables' rectangle overwrite on the same handlePaste ladder.
  // The cell press router rides AFTER the parent's for the mirrored reason:
  // a column-resize press must claim first, and the cell-sweep drag must arm
  // its listeners before the router claims an inert padding press.
  addProseMirrorPlugins() {
    return [
      tableSweepPastePlugin(),
      ...(this.parent?.() ?? []),
      cellInteriorPressPlugin(this.editor),
    ];
  },

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
  content: "block+",

  addAttributes() {
    return tableCellAttributes(this.parent);
  },
});

export const MeridianTableCell = TableCell.extend({
  name: "table_cell",
  content: "block+",

  addAttributes() {
    return tableCellAttributes(this.parent);
  },
});

/**
 * The stored link target (`doc:`/`ahead:`) on images and figures. Never
 * rendered; read back only from the attribute the link clipboard plugin leaves
 * on a same-project rich paste's `<img>` (a figure's own picture), which the
 * paste sanitizer never lets clipboard HTML set (`links/link-clipboard.ts`).
 */
/**
 * A picture's stored source. Rendered only when the browser may fetch it as
 * written; anything else is named on the clipboard by its metadata
 * (`links/link-clipboard.ts`), never by an `<img src>` the browser would load.
 */
const PICTURE_SOURCE_ATTRIBUTE = {
  default: "",
  renderHTML: (attrs: Record<string, unknown>) => {
    const src = browserPictureSource(typeof attrs.src === "string" ? attrs.src : "");
    return src === null ? {} : { src };
  },
};

const PICTURE_REF_ATTRIBUTE = {
  default: null,
  rendered: false,
  parseHTML: (element: HTMLElement) => {
    const picture = element.localName === "img" ? element : element.querySelector("img");
    return clipboardLinkRef(picture?.getAttribute(LINK_KEPT_REF_ATTRIBUTE) ?? null);
  },
};

/**
 * The link mark's ref. Never rendered; read back only from the attribute the
 * link clipboard plugin leaves on a same-project rich paste, which the paste
 * sanitizer never lets clipboard HTML set (`links/link-clipboard.ts`).
 */
const LINK_MARK_REF_ATTRIBUTE = {
  default: null,
  rendered: false,
  parseHTML: (element: HTMLElement) =>
    clipboardLinkRef(element.getAttribute(LINK_KEPT_REF_ATTRIBUTE)),
};

// ─── Customized extensions ──────────────────────────────────────────
// Extensions that add behavior beyond what TipTap defaults provide.

/**
 * A link mark's `<a>` attributes. Internal targets are semantic references,
 * not browser URLs: they keep their exact spelling in clipboard HTML, and only
 * external targets get a live href.
 */
function linkElementAttributes(HTMLAttributes: Record<string, unknown>): Record<string, unknown> {
  const target = classifyLinkTarget(String(HTMLAttributes.href ?? ""));
  const folder = target && isInternalLinkTarget(target) && target.addressKind === "folder";
  return target
    ? {
        ...HTMLAttributes,
        href: isInternalLinkTarget(target) ? undefined : linkTargetHref(target),
        "data-meridian-link": isInternalLinkTarget(target) ? HTMLAttributes.href : undefined,
        role: folder ? "button" : "link",
        "aria-haspopup": folder ? "menu" : undefined,
        tabindex: "0",
        "data-link-kind": target.kind,
      }
    : { ...HTMLAttributes, href: "" };
}

// What a link IS. What pressing one DOES belongs to the link surface
// (`core/editor/links/`), which owns the click, the hover, and the menu.
export const MeridianLink = Link.extend({
  inclusive: false,

  /**
   * Rendered, not stored: `data-link-kind` is what lets CSS give an external
   * link its trailing arrow. An internal link's chip is drawn by the mark
   * view (`addMarkView`), never from the mark. It is absent from
   * `addAttributes`, so it never reaches the schema, the wire format, or
   * another peer's document.
   *
   * It replaces TipTap's own renderHTML, so it also carries TipTap's fence:
   * an href the classifier does not recognize renders with no destination.
   * A `javascript:` URL can still reach the document through a markdown parse,
   * and it must not become a live link when it does.
   */
  renderHTML({ HTMLAttributes }) {
    return [
      "a",
      mergeAttributes(this.options.HTMLAttributes, linkElementAttributes(HTMLAttributes)),
      0,
    ];
  },

  /**
   * The same `<a>` as `renderHTML` (which clipboard HTML still uses), plus
   * its answer: the chip and its accessible state (`drawLinkAnswer`), the
   * only place a link's answer is drawn. Those attributes are set on the live
   * element, so its own attribute mutations are not a document change.
   */
  addMarkView() {
    const { editor, options } = this;
    return ({ mark, HTMLAttributes }) => {
      const { dom, contentDOM } = DOMSerializer.renderSpec(document, [
        "a",
        mergeAttributes(options.HTMLAttributes, linkElementAttributes(HTMLAttributes)),
        0,
      ]);
      const element = dom as HTMLElement;
      // A changed ref or href is a different mark, and a new view.
      const release = drawLinkAnswer(element, mark.attrs, mountedLinks(editor));
      return {
        dom: element,
        contentDOM,
        ignoreMutation: (mutation) => mutation.type === "attributes" && mutation.target === element,
        destroy: release,
      };
    };
  },

  parseHTML() {
    return [
      {
        tag: "[data-meridian-link]",
        getAttrs: (element) => {
          const href = internalClipboardTarget(element.getAttribute("data-meridian-link"));
          return href ? { href } : false;
        },
      },
      ...(this.parent?.() ?? []),
    ];
  },

  addAttributes() {
    return {
      href: {
        default: "",
        parseHTML: (element) =>
          internalClipboardTarget(element.getAttribute("data-meridian-link")) ??
          element.getAttribute("href"),
      },
      title: { default: null },
      ref: LINK_MARK_REF_ATTRIBUTE,
    };
  },
}).configure({
  openOnClick: false,

  /**
   * TipTap's own allow-list is web schemes, which reads `manuscript://` and
   * `work://` as attacks and drops the mark on parse and on every command.
   * The classifier is the fence instead: it knows the internal family and
   * keeps the same refusal for `javascript:` and `data:`.
   */
  isAllowedUri: (uri) => classifyLinkTarget(String(uri ?? "")) !== null,

  /**
   * Bare-URL autolink stays (§5.5), but it may not swallow the relative
   * spelling: linkify reads `chapter-213.md` as a hostname under the `.md`
   * TLD and would rewrite a project document into an external site. What a
   * writer typed is exactly what the link form normalizes, so ask that.
   */
  shouldAutoLink: (url) => {
    const href = normalizeLinkHref(url);
    return href !== null && classifyLinkTarget(href)?.kind === "external";
  },

  // A link the writer typed without a scheme goes to the secure one.
  defaultProtocol: "https",

  // The editor owns every follow (new tab for external, in-app for internal),
  // so `target="_blank"` describes nothing and `nofollow` is an SEO artifact
  // in a manuscript. `rel` stays as the fence for anything that does navigate.
  HTMLAttributes: { target: null, rel: "noopener noreferrer" },
});

export const MeridianImage = Image.extend<ImageOptions & { projectId?: string; owner?: string }>({
  marks: "",

  addOptions() {
    const parent = this.parent?.();
    if (!parent) throw new Error("MeridianImage requires the base image options");
    return { ...parent, projectId: undefined, owner: undefined };
  },

  addAttributes() {
    return {
      src: PICTURE_SOURCE_ATTRIBUTE,
      alt: { default: null },
      title: { default: null },
      uploadToken: UPLOAD_TOKEN_ATTRIBUTE,
      width: IMAGE_WIDTH_ATTRIBUTE,
      ref: PICTURE_REF_ATTRIBUTE,
    };
  },

  /** One gesture the browser would otherwise answer for itself. */
  addProseMirrorPlugins() {
    return [imageDragPreviewPlugin()];
  },

  addNodeView() {
    // A picture in flight never changes its node — its slot is final from the
    // first moment — so the default "re-render when the node changes" would
    // never repaint the progress. The decoration is what changes, and this is
    // the node view asking to hear about it.
    return ReactNodeViewRenderer(ImageNodeView, {
      update: ({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) => {
        if (oldNode.type !== newNode.type) return false;
        if (
          oldNode !== newNode ||
          pendingImageSignature(oldDecorations) !== pendingImageSignature(newDecorations) ||
          // The resize grips exist while the jade ring does, and a selection
          // change moves neither the node nor the upload. The ring's own
          // decoration is the signal both read.
          objectSelectedInDecorations(oldDecorations) !==
            objectSelectedInDecorations(newDecorations)
        ) {
          updateProps();
        }
        return true;
      },
    });
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

export const MeridianFigure = Node.create<{ projectId?: string; owner?: string }>({
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
      owner: undefined,
    };
  },

  addAttributes() {
    return {
      src: { default: "", rendered: false },
      alt: { default: null },
      label: { default: null },
      caption: { default: "" },
      uploadToken: UPLOAD_TOKEN_ATTRIBUTE,
      ref: PICTURE_REF_ATTRIBUTE,
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

  renderHTML({ node, HTMLAttributes }) {
    const attrs = HTMLAttributes as RenderAttrs;
    const src = browserPictureSource(typeof node.attrs.src === "string" ? node.attrs.src : "");
    const alt = typeof attrs.alt === "string" ? attrs.alt : null;
    const label = typeof attrs.label === "string" ? attrs.label : null;
    const caption = typeof attrs.caption === "string" ? attrs.caption : "";

    return [
      "figure",
      mergeAttributes(HTMLAttributes, { "data-type": "figure", "data-label": label }),
      ["img", src === null ? { alt } : { src, alt }],
      ["figcaption", caption],
    ];
  },
});
