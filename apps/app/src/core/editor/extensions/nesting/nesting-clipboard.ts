/**
 * Lists on the clipboard. Other apps read and write lists as `ul`, `ol` and `li` around
 * blocks; here a list is blocks that carry their nesting. `nestDom` wraps copied blocks in the
 * lists `nestTree` reads from them, and `flattenDom` unwraps pasted lists into blocks that
 * carry `data-` nesting attributes, which the blocks' parse rules read.
 */
import { type NestedNode, nestNodes, nestTree, readPath } from "@meridian/prosemirror-schema";
import { DOMSerializer, type Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";

export const NESTING_DATA_ATTRIBUTES = ["data-path", "data-kind", "data-marker", "data-start"];

/** Elements that become a block of their own. A `div` holding blocks is only a wrapper. */
const BLOCK_ELEMENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "table",
  "hr",
  "figure",
  "div",
]);
const LIST_ELEMENTS = new Set(["ul", "ol"]);
/** Containers whose blocks are a sequence of their own: a path never crosses into them. */
const SEQUENCE_BOUNDARIES = "blockquote, td, th";

type ItemFacts = { ordered: boolean; start: number | null };

function isElement(node: Node, names: ReadonlySet<string>): node is Element {
  return node.nodeType === Node.ELEMENT_NODE && names.has((node as Element).localName);
}

function isBlank(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !node.textContent?.trim();
}

function holdsBlocks(element: Element): boolean {
  return [...element.children].some(
    (child) => BLOCK_ELEMENTS.has(child.localName) || LIST_ELEMENTS.has(child.localName),
  );
}

/** A drawn checkbox: GitHub's `input`, or the picture Google Docs puts in a checklist item. */
function isCheckbox(node: Node): node is Element {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  return (
    (element.localName === "input" && element.getAttribute("type") === "checkbox") ||
    element.getAttribute("aria-roledescription") === "checkbox"
  );
}

/** A task item's state, as GitHub (a checkbox), Google Docs (`aria-checked`) and this editor (`data-checked`) write it. */
function taskMarker(item: Element): "todo" | "done" | null {
  const flag = item.getAttribute("data-checked") ?? item.getAttribute("aria-checked");
  if (flag === "true") return "done";
  if (flag === "false") return "todo";
  const box = [...item.children].find(isCheckbox);
  if (box?.localName === "input") return box.hasAttribute("checked") ? "done" : "todo";
  return null;
}

function walkList(list: Element, depth: number, out: Element[]): void {
  const ordered = list.localName === "ol";
  const start = Number(list.getAttribute("start") ?? 1);
  let first = true;
  for (const child of [...list.childNodes]) {
    // `ul > ul`, which some apps write, nests under the item before it.
    if (isElement(child, LIST_ELEMENTS)) {
      walkList(child, depth + 1, out);
      continue;
    }
    if (isBlank(child)) continue;
    const item =
      child.nodeType === Node.ELEMENT_NODE && (child as Element).localName === "li"
        ? (child as Element)
        : wrapIn(child, "li");
    const facts = {
      ordered,
      start: first && ordered && Number.isInteger(start) && start !== 1 ? start : null,
    };
    walkItem(item, depth + 1, facts, out);
    first = false;
  }
}

function wrapIn(node: Node, name: string): Element {
  const wrapper = (node.ownerDocument as Document).createElement(name);
  wrapper.appendChild(node.cloneNode(true));
  return wrapper;
}

function walkItem(item: Element, depth: number, facts: ItemFacts, out: Element[]): void {
  const document = item.ownerDocument;
  // Google Docs writes each item's depth on it, whatever the nesting of the lists around it.
  const level = Number(item.getAttribute("aria-level"));
  const itemDepth = Number.isInteger(level) && level > 0 ? level : depth;
  const marker = taskMarker(item) ?? "item";
  let opened = false;
  let inline: Node[] = [];

  const emit = (block: Element) => {
    block.setAttribute("data-path", "-".repeat(itemDepth));
    if (!opened) {
      block.setAttribute("data-marker", marker);
      if (facts.ordered) block.setAttribute("data-kind", "ordered");
      if (facts.start !== null) block.setAttribute("data-start", String(facts.start));
    }
    opened = true;
    out.push(block);
  };
  const flush = () => {
    if (inline.some((node) => !isBlank(node))) {
      const paragraph = document.createElement("p");
      for (const node of inline) paragraph.appendChild(node);
      emit(paragraph);
    }
    inline = [];
  };
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if (isCheckbox(node)) continue;
      if (isElement(node, LIST_ELEMENTS)) {
        flush();
        // The item's own block comes first, even when it has no words before its children.
        if (!opened) emit(document.createElement("p"));
        walkList(node, itemDepth, out);
      } else if (isElement(node, BLOCK_ELEMENTS)) {
        flush();
        if (node.localName === "div" && holdsBlocks(node)) walk([...node.childNodes]);
        else emit(node);
      } else inline.push(node);
    }
  };
  walk([...item.childNodes]);
  flush();
  if (!opened) emit(document.createElement("p"));
}

/** The outermost list in its sequence, or null when none is left. */
function outermostList(root: Element): Element | null {
  for (const list of root.querySelectorAll("ul, ol")) {
    const around = list.parentElement?.closest(`ul, ol, li, ${SEQUENCE_BOUNDARIES}`);
    if (!around || !root.contains(around) || around.matches(SEQUENCE_BOUNDARIES)) return list;
  }
  return null;
}

/**
 * Unwraps every list under `root` into its blocks, each carrying `data-path`, and on an
 * item's first block `data-marker`, `data-kind` and `data-start`. Nesting attributes the
 * source wrote itself are dropped first, so only what this pass read reaches the parser.
 */
export function flattenDom(root: Element): void {
  for (const element of root.querySelectorAll(
    NESTING_DATA_ATTRIBUTES.map((name) => `[${name}]`).join(", "),
  )) {
    for (const name of NESTING_DATA_ATTRIBUTES) element.removeAttribute(name);
  }
  // Lists inside a quote or a cell of an item are a sequence of their own, reached on a later pass.
  for (let list = outermostList(root); list; list = outermostList(root)) {
    const blocks: Element[] = [];
    walkList(list, 0, blocks);
    list.replaceWith(...blocks);
  }
}

function nestDom(tree: readonly NestedNode[], blocks: readonly Node[], document: Document) {
  const out: Node[] = [];
  for (const node of tree) {
    if (node.type === "block") {
      out.push(blocks[node.index]);
    } else if (node.type === "quote") {
      const quote = document.createElement("blockquote");
      quote.append(...nestDom(node.children, blocks, document));
      out.push(quote);
    } else {
      const ordered = node.list.kind === "ordered";
      const list = document.createElement(ordered ? "ol" : "ul");
      if (ordered && node.list.start !== 1) list.setAttribute("start", String(node.list.start));
      for (const item of node.items) {
        const li = document.createElement("li");
        if (item.marker === "todo" || item.marker === "done") {
          li.setAttribute("data-checked", String(item.marker === "done"));
        }
        li.append(...nestDom(item.children, blocks, document));
        list.appendChild(li);
      }
      out.push(list);
    }
  }
  return out;
}

/** The editor's clipboard HTML: blocks in the `ul`, `ol` and `li` other apps expect. */
export class NestingDOMSerializer extends DOMSerializer {
  serializeFragment(
    fragment: Fragment,
    options: { document?: Document } = {},
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const serialized = super.serializeFragment(fragment, options);
    const nodes: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      nodes.push(node);
    });
    const document = options.document ?? window.document;
    const into = target ?? document.createDocumentFragment();
    const listed = nodes.some((node) => readPath(node.attrs.path).length > 0);
    if (!listed || serialized.childNodes.length !== nodes.length) {
      into.appendChild(serialized);
      return into;
    }
    into.append(...nestDom(nestTree(nestNodes(nodes)), [...serialized.childNodes], document));
    return into;
  }
}
