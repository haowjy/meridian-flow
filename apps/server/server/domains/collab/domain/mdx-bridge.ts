/**
 * MDX ↔ ProseMirror bridge for manuscript projection. Hand-rolled mdast mapping
 * with pinned remark-stringify options (determinism contract), autolink demotion,
 * empty-paragraph U+00A0 sentinel encoding, and Phase-1 `<Figure/>` allowlist.
 *
 * Whitespace-only paragraphs canonicalize to empty: a paragraph containing only
 * spaces/tabs/NBSP renders as the same blank vertical space as an empty paragraph,
 * so serialize and parse treat them as equivalent (sentinel on wire, empty in PM).
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Mark, Node as PMNode, Schema } from "prosemirror-model";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const documentSchema = buildDocumentSchema();

/** Frozen remark-stringify options — wire-format determinism contract. */
export const MDX_STRINGIFY_OPTIONS = {
  bullet: "-",
  bulletOther: "*",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  incrementListMarker: true,
  resourceLink: false,
  setext: false,
  tightDefinitions: true,
} as const;

const COMPONENT_ALLOWLIST = new Set(["Figure"]);

const FIGURE_ATTRS = new Set(["src", "alt", "caption", "label"]);

/** Non-breaking space — one per empty PM paragraph on the wire. */
const EMPTY_PARAGRAPH_SENTINEL = "\u00a0";

function isWhitespaceOnlyText(value: string): boolean {
  return value.length > 0 && /^\s+$/.test(value);
}

function isWhitespaceOnlyParagraph(node: PMNode): boolean {
  if (node.childCount === 0) return true;
  return isWhitespaceOnlyText(node.textContent);
}

function isPascalCaseComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function skipBalanced(text: string, start: number, open: string, close: string): number | null {
  if (text[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === open) depth++;
    if (text[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** Pass through PascalCase JSX tags; escape other bare `<`/`{` for prose-safe ingress. */
function tryConsumeJsxTag(text: string, start: number): number | null {
  if (text[start] !== "<") return null;
  let i = start + 1;
  const closing = text[i] === "/";
  if (closing) i++;

  const nameStart = i;
  if (!/[A-Z]/.test(text[i] ?? "")) return null;
  while (i < text.length && /[A-Za-z0-9]/.test(text[i] ?? "")) i++;
  const name = text.slice(nameStart, i);
  if (!isPascalCaseComponentName(name)) return null;

  if (closing) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (text[i] === ">") return i + 1 - start;
    return null;
  }

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (i >= text.length) return null;

    if (text[i] === "/") {
      if (text[i + 1] === ">") return i + 2 - start;
      return null;
    }
    if (text[i] === ">") return i + 1 - start;

    if (text[i] === "{") {
      const end = skipBalanced(text, i, "{", "}");
      if (end === null) return null;
      i = end;
      continue;
    }

    const attrStart = i;
    while (i < text.length && /[A-Za-z0-9:_-]/.test(text[i] ?? "")) i++;
    if (i === attrStart) return null;

    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (text[i] !== "=") continue;
    i++;
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;

    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < text.length && text[i] !== quote) i++;
      if (i >= text.length) return null;
      i++;
    } else if (text[i] === "{") {
      const end = skipBalanced(text, i, "{", "}");
      if (end === null) return null;
      i = end;
    } else {
      while (i < text.length && !/[\s/>]/.test(text[i] ?? "")) i++;
    }
  }
  return null;
}

/** Escape prose `<`/`{` within a segment (respects inline code and JSX tags). */
function escapeProseSegment(segment: string): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "\\" && i + 1 < segment.length) {
      out += segment[i] + segment[i + 1];
      i += 2;
      continue;
    }
    if (segment[i] === "`") {
      let j = i + 1;
      while (j < segment.length && segment[j] !== "`") j++;
      if (j < segment.length) j++;
      out += segment.slice(i, j);
      i = j;
      continue;
    }
    if (segment[i] === "<") {
      const len = tryConsumeJsxTag(segment, i);
      if (len !== null) {
        out += segment.slice(i, i + len);
        i += len;
        continue;
      }
      out += "\\<";
      i++;
      continue;
    }
    if (segment[i] === "{") {
      out += "\\{";
      i++;
      continue;
    }
    out += segment[i];
    i++;
  }
  return out;
}

/** Escape prose `<`/`{` before remark-parse; idempotent on bridge-produced MDX. */
function escapeProseForMdxIngress(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeFence = false;
  let fenceMarker = "";
  let inMathDisplay = false;

  for (const line of lines) {
    if (inCodeFence) {
      out.push(line);
      if (line.trimStart().startsWith(fenceMarker)) {
        inCodeFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inMathDisplay) {
      out.push(line);
      if (line.trim() === "$$") {
        inMathDisplay = false;
      }
      continue;
    }

    const fence = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      inCodeFence = true;
      fenceMarker = fence[1];
      out.push(line);
      continue;
    }
    if (line.trim() === "$$") {
      inMathDisplay = true;
      out.push(line);
      continue;
    }

    out.push(escapeProseSegment(line));
  }
  return out.join("\n");
}

const toMdxProcessor = unified()
  .use(remarkStringify, MDX_STRINGIFY_OPTIONS)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkMdx);

const fromMdxProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkMdx);

type MdastRoot = { type: "root"; children: MdastBlock[] };
type MdastBlock =
  | MdastParagraph
  | MdastHeading
  | MdastBlockquote
  | MdastCode
  | MdastMath
  | MdastList
  | MdastTable
  | MdastThematicBreak
  | MdastJsxFlow;
type MdastInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MdastInline[] }
  | { type: "emphasis"; children: MdastInline[] }
  | { type: "inlineCode"; value: string }
  | { type: "link"; url: string; title: string | null; children: MdastInline[] }
  | { type: "break" }
  | { type: "image"; url: string; alt: string | null; title: string | null }
  | {
      type: "mdxJsxTextElement";
      name: string;
      attributes: MdastJsxAttr[];
      children: unknown[];
    };

type MdastParagraph = { type: "paragraph"; children: MdastInline[] };
type MdastHeading = { type: "heading"; depth: number; children: MdastInline[] };
type MdastBlockquote = { type: "blockquote"; children: MdastBlock[] };
type MdastCode = { type: "code"; lang: string | null; value: string };
type MdastMath = { type: "math"; value: string };
type MdastList = {
  type: "list";
  ordered: boolean;
  start?: number;
  spread: boolean;
  children: MdastListItem[];
};
type MdastListItem = { type: "listItem"; spread: boolean; children: MdastBlock[] };
type MdastTable = {
  type: "table";
  align: (null | "left" | "center" | "right")[];
  children: MdastTableRow[];
};
type MdastTableRow = {
  type: "tableRow";
  children: { type: "tableCell"; children: MdastInline[] }[];
};
type MdastThematicBreak = { type: "thematicBreak" };
type MdastJsxFlow = {
  type: "mdxJsxFlowElement";
  name: string;
  attributes: MdastJsxAttr[];
  children: unknown[];
};
type MdastJsxAttr =
  | { type: "mdxJsxAttribute"; name: string; value: string | null }
  | { type: "mdxJsxExpressionAttribute"; name?: string }
  | { type: "mdxJsxSpreadAttribute" };

function jsxAttr(name: string, value: string | null | undefined): MdastJsxAttr | null {
  if (value === null || value === undefined) return null;
  return { type: "mdxJsxAttribute", name, value: String(value) };
}

function marksToInline(text: string, marks: readonly Mark[]): MdastInline {
  let node: MdastInline = { type: "text", value: text };
  const order = ["code", "em", "strong", "link"];
  const sorted = [...marks].sort((a, b) => order.indexOf(a.type.name) - order.indexOf(b.type.name));
  for (const mark of sorted) {
    if (mark.type.name === "strong") node = { type: "strong", children: [node] };
    else if (mark.type.name === "em") node = { type: "emphasis", children: [node] };
    else if (mark.type.name === "code") node = { type: "inlineCode", value: text };
    else if (mark.type.name === "link")
      node = {
        type: "link",
        url: mark.attrs.href ?? "",
        title: mark.attrs.title ?? null,
        children: [node],
      };
  }
  return node;
}

function inlineChildrenToMdast(node: PMNode): MdastInline[] {
  const out: MdastInline[] = [];
  node.forEach((child) => {
    if (child.type.name === "text") {
      out.push(marksToInline(child.text ?? "", child.marks));
    } else if (child.type.name === "hard_break") {
      out.push({ type: "break" });
    } else if (child.type.name === "image") {
      out.push({
        type: "image",
        url: child.attrs.src ?? "",
        alt: child.attrs.alt ?? null,
        title: child.attrs.title ?? null,
      });
    } else {
      throw new Error(`pm->mdast: unsupported inline node "${child.type.name}"`);
    }
  });
  return out;
}

function paragraphToMdast(node: PMNode): MdastParagraph {
  if (isWhitespaceOnlyParagraph(node)) {
    return {
      type: "paragraph",
      children: [{ type: "text", value: EMPTY_PARAGRAPH_SENTINEL }],
    };
  }
  return { type: "paragraph", children: inlineChildrenToMdast(node) };
}

function listItemToMdast(node: PMNode): MdastListItem {
  return {
    type: "listItem",
    spread: false,
    children: node.content.content.map(blockToMdast),
  };
}

function tableToMdast(node: PMNode): MdastTable {
  const rows = node.content.content.map((row) => ({
    type: "tableRow" as const,
    children: row.content.content.map((cell) => ({
      type: "tableCell" as const,
      children: inlineChildrenToMdast(cell),
    })),
  }));
  return { type: "table", align: [], children: rows };
}

function figureToMdast(node: PMNode): MdastJsxFlow {
  const attrs = [
    jsxAttr("src", node.attrs.src),
    jsxAttr("alt", node.attrs.alt),
    jsxAttr("caption", node.attrs.caption),
    jsxAttr("label", node.attrs.label),
  ].filter((a): a is MdastJsxAttr => a !== null);
  return { type: "mdxJsxFlowElement", name: "Figure", attributes: attrs, children: [] };
}

function blockToMdast(node: PMNode): MdastBlock {
  switch (node.type.name) {
    case "paragraph":
      return paragraphToMdast(node);
    case "heading":
      return {
        type: "heading",
        depth: node.attrs.level,
        children: inlineChildrenToMdast(node),
      };
    case "blockquote":
      return { type: "blockquote", children: node.content.content.map(blockToMdast) };
    case "code_block":
      return { type: "code", lang: node.attrs.language ?? null, value: node.textContent };
    case "math_display":
      return { type: "math", value: node.textContent };
    case "bullet_list":
      return {
        type: "list",
        ordered: false,
        spread: !node.attrs.tight,
        children: node.content.content.map(listItemToMdast),
      };
    case "ordered_list":
      return {
        type: "list",
        ordered: true,
        start: node.attrs.order ?? 1,
        spread: !node.attrs.tight,
        children: node.content.content.map(listItemToMdast),
      };
    case "table":
      return tableToMdast(node);
    case "figure":
      return figureToMdast(node);
    case "horizontal_rule":
      return { type: "thematicBreak" };
    default:
      throw new Error(`pm->mdast: unsupported block node "${node.type.name}"`);
  }
}

function pmDocToMdastTree(doc: PMNode): MdastRoot {
  return { type: "root", children: doc.content.content.map(blockToMdast) };
}

export function docToMdx(root: PMNode): string {
  return toMdxProcessor.stringify(
    pmDocToMdastTree(root) as Parameters<typeof toMdxProcessor.stringify>[0],
  );
}

export function blockToMdx(block: PMNode): string {
  return toMdxProcessor.stringify({
    type: "root",
    children: [blockToMdast(block)],
  } as Parameters<typeof toMdxProcessor.stringify>[0]);
}

function addMark(marks: readonly Mark[], name: string, attrs?: Record<string, unknown>): Mark[] {
  return marks.concat(documentSchema.marks[name].create(attrs));
}

function inlineMdastToPm(children: MdastInline[], activeMarks: readonly Mark[] = []): PMNode[] {
  const out: PMNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text":
        if (child.value.length) out.push(documentSchema.text(child.value, activeMarks));
        break;
      case "strong":
        out.push(...inlineMdastToPm(child.children, addMark(activeMarks, "strong")));
        break;
      case "emphasis":
        out.push(...inlineMdastToPm(child.children, addMark(activeMarks, "em")));
        break;
      case "inlineCode":
        out.push(documentSchema.text(child.value, addMark(activeMarks, "code")));
        break;
      case "link":
        out.push(
          ...inlineMdastToPm(
            child.children,
            addMark(activeMarks, "link", { href: child.url ?? "", title: child.title ?? null }),
          ),
        );
        break;
      case "break":
        out.push(documentSchema.node("hard_break"));
        break;
      case "image":
        out.push(
          documentSchema.node("image", {
            src: child.url ?? "",
            alt: child.alt ?? null,
            title: child.title ?? null,
          }),
        );
        break;
      case "mdxJsxTextElement":
        if (isPascalCaseComponentName(child.name)) {
          validateFigureJsx(child);
        }
        throw new Error(`mdast->pm: unsupported inline "mdxJsxTextElement"`);
      default:
        throw new Error(`mdast->pm: unsupported inline "${(child as MdastInline).type}"`);
    }
  }
  return out;
}

function isSentinelParagraph(node: MdastParagraph): boolean {
  if (node.children.length === 0) return true;
  if (node.children.length !== 1) return false;
  const only = node.children[0];
  return (
    only.type === "text" &&
    (only.value === EMPTY_PARAGRAPH_SENTINEL || isWhitespaceOnlyText(only.value))
  );
}

function attrMap(node: { attributes?: MdastJsxAttr[] }): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of node.attributes ?? []) {
    if (a.type === "mdxJsxSpreadAttribute") {
      throw new Error("Figure: spread attrs forbidden");
    }
    if (a.type === "mdxJsxExpressionAttribute") {
      throw new Error("Figure: expression attrs forbidden");
    }
    if (a.value === null) {
      throw new Error(
        `Figure: boolean/shorthand attribute "${a.name}" forbidden (use quoted strings)`,
      );
    }
    if (typeof a.value !== "string") {
      throw new Error(`Figure: expression-valued attr "${a.name}" forbidden`);
    }
    map[a.name] = a.value;
  }
  return map;
}

function validateFigureJsx(node: {
  name: string;
  attributes?: MdastJsxAttr[];
  children?: unknown[];
}): Record<string, string> {
  if (!COMPONENT_ALLOWLIST.has(node.name)) {
    throw new Error(`unknown component <${node.name}/> — not in allowlist`);
  }
  if ((node.children?.length ?? 0) > 0) {
    throw new Error("Figure: non-empty children forbidden (use self-closing <Figure ... /> only)");
  }
  const m = attrMap(node);
  for (const key of Object.keys(m)) {
    if (!FIGURE_ATTRS.has(key)) {
      throw new Error(`Figure: unknown attribute "${key}" (allowed: src, alt, caption, label)`);
    }
  }
  return m;
}

function jsxFlowToPm(node: MdastJsxFlow): PMNode {
  const m = validateFigureJsx(node);
  return documentSchema.node("figure", {
    src: m.src ?? "",
    alt: m.alt ?? null,
    caption: m.caption ?? "",
    label: m.label ?? null,
  });
}

function listItemMdastToPm(node: MdastListItem): PMNode {
  return documentSchema.node("list_item", null, node.children.map(blockMdastToPm));
}

function tableMdastToPm(node: MdastTable): PMNode {
  const rows = node.children.map((row, ri) =>
    documentSchema.node(
      "table_row",
      null,
      row.children.map((cell) =>
        documentSchema.node(
          ri === 0 ? "table_header" : "table_cell",
          null,
          inlineMdastToPm(cell.children),
        ),
      ),
    ),
  );
  return documentSchema.node("table", null, rows);
}

function blockMdastToPm(node: MdastBlock): PMNode {
  switch (node.type) {
    case "paragraph":
      if (isSentinelParagraph(node)) return documentSchema.node("paragraph", null, []);
      return documentSchema.node("paragraph", null, inlineMdastToPm(node.children));
    case "heading":
      return documentSchema.node("heading", { level: node.depth }, inlineMdastToPm(node.children));
    case "blockquote":
      return documentSchema.node("blockquote", null, node.children.map(blockMdastToPm));
    case "code":
      return documentSchema.node(
        "code_block",
        { language: node.lang ?? null },
        node.value.length ? [documentSchema.text(node.value)] : [],
      );
    case "math":
      return documentSchema.node(
        "math_display",
        null,
        node.value.length ? [documentSchema.text(node.value)] : [],
      );
    case "list":
      return node.ordered
        ? documentSchema.node(
            "ordered_list",
            { order: node.start ?? 1, tight: !node.spread },
            node.children.map(listItemMdastToPm),
          )
        : documentSchema.node(
            "bullet_list",
            { tight: !node.spread },
            node.children.map(listItemMdastToPm),
          );
    case "table":
      return tableMdastToPm(node);
    case "thematicBreak":
      return documentSchema.node("horizontal_rule");
    case "mdxJsxFlowElement":
      return jsxFlowToPm(node);
    default:
      throw new Error(`mdast->pm: unsupported block "${(node as MdastBlock).type}"`);
  }
}

function demoteAutolinks(tree: MdastRoot): MdastRoot {
  visit(tree, "link", (node, idx, parent) => {
    if (idx == null || !parent || !("children" in parent)) return;
    const link = node as {
      type: "link";
      url: string;
      title: string | null;
      children: MdastInline[];
    };
    const first = link.children[0];
    const onlyText = link.children.length === 1 && first?.type === "text";
    if (onlyText && first.type === "text" && first.value === link.url && !link.title) {
      (parent.children as MdastInline[])[idx] = { type: "text", value: first.value };
    }
  });
  return tree;
}

export function mdxToDoc(text: string): PMNode {
  if (text.trim().length === 0) {
    return documentSchema.node("doc", null, [documentSchema.node("paragraph", null, [])]);
  }
  const tree = demoteAutolinks(fromMdxProcessor.parse(escapeProseForMdxIngress(text)) as MdastRoot);
  const blocks = tree.children.map(blockMdastToPm);
  if (blocks.length === 0) {
    return documentSchema.node("doc", null, [documentSchema.node("paragraph", null, [])]);
  }
  return documentSchema.node("doc", null, blocks);
}

/** Document schema used by the bridge (same as `getSchema("document")`). */
export function documentMdxSchema(): Schema {
  return documentSchema;
}
