/**
 * Lists and quotes on the clipboard. Other apps read and write them as `ul`, `ol`, `li` and
 * `blockquote` around blocks; here they are blocks that carry their nesting. `nestDom` wraps
 * copied blocks in the containers `nestTree` reads from them, and `flattenDom` unwraps pasted
 * containers into blocks that carry `data-` nesting attributes, which the blocks' parse rules
 * read.
 */
import { isNested, type NestedNode, nestNodes, nestTree } from "@meridian/prosemirror-schema";
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
  "table",
  "hr",
  "figure",
  "div",
]);
const LIST_ELEMENTS = new Set(["ul", "ol"]);
const CONTAINERS = "ul, ol, blockquote";
/** Cells hold blocks that are a sequence of their own: a path never crosses into them. */
const SEQUENCE_BOUNDARIES = "td, th";

type ItemFacts = { ordered: boolean; start: number | null };
/** Hands a block on with the path it sits at, outermost container first. */
type Emit = (block: Element, path: string) => void;

function isElement(node: Node, names: ReadonlySet<string>): node is Element {
  return node.nodeType === Node.ELEMENT_NODE && names.has((node as Element).localName);
}

function isQuote(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === "blockquote";
}

function isBlank(node: Node): boolean {
  return (
    (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) ||
    node.nodeType === Node.COMMENT_NODE
  );
}

function holdsBlocks(element: Element): boolean {
  return [...element.children].some(
    (child) =>
      BLOCK_ELEMENTS.has(child.localName) || LIST_ELEMENTS.has(child.localName) || isQuote(child),
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

/**
 * The blocks among `nodes`, at `path`. Loose words between blocks become a paragraph. A quote
 * right after a quote starts a new one (`|`), so two quotes stay two.
 */
function walkBlocks(nodes: readonly Node[], path: string, emit: Emit, document: Document): void {
  let inline: Node[] = [];
  let previous: Node | null = null;
  const flush = () => {
    if (inline.some((node) => !isBlank(node))) {
      const paragraph = document.createElement("p");
      for (const node of inline) paragraph.appendChild(node);
      emit(paragraph, path);
      previous = paragraph;
    }
    inline = [];
  };
  for (const node of nodes) {
    if (isCheckbox(node)) continue;
    if (isElement(node, LIST_ELEMENTS)) {
      flush();
      walkList(node, path, emit, document);
      previous = node;
    } else if (isQuote(node)) {
      flush();
      const fresh = previous !== null && isQuote(previous);
      let first = true;
      const quoted: Emit = (block, at) => {
        emit(block, first && fresh ? `${at.slice(0, path.length)}|${at.slice(path.length)}` : at);
        first = false;
      };
      walkBlocks([...node.childNodes], `${path}>`, quoted, document);
      // An empty quote still holds a line.
      if (first) quoted(document.createElement("p"), `${path}>`);
      previous = node;
    } else if (isElement(node, BLOCK_ELEMENTS)) {
      flush();
      if (node.localName === "div" && holdsBlocks(node)) {
        walkBlocks([...node.childNodes], path, emit, document);
      } else emit(node, path);
      previous = node;
    } else if (!isBlank(node) || inline.length > 0) inline.push(node);
  }
  flush();
}

function walkList(list: Element, path: string, emit: Emit, document: Document): void {
  const ordered = list.localName === "ol";
  const start = Number(list.getAttribute("start") ?? 1);
  let first = true;
  for (const child of [...list.childNodes]) {
    // `ul > ul`, which some apps write, nests under the item before it.
    if (isElement(child, LIST_ELEMENTS)) {
      walkList(child, `${path}-`, emit, document);
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
    walkItem(item, path, facts, emit, document);
    first = false;
  }
}

function wrapIn(node: Node, name: string): Element {
  const wrapper = (node.ownerDocument as Document).createElement(name);
  wrapper.appendChild(node.cloneNode(true));
  return wrapper;
}

function walkItem(
  item: Element,
  path: string,
  facts: ItemFacts,
  emit: Emit,
  document: Document,
): void {
  // Google Docs writes each item's depth on it, whatever the nesting of the lists around it.
  const level = Number(item.getAttribute("aria-level"));
  const itemPath =
    Number.isInteger(level) && level > 0 ? path.replace(/-+$/, "") + "-".repeat(level) : `${path}-`;
  const marker = taskMarker(item) ?? "item";
  let opened = false;
  const own: Emit = (block, at) => {
    if (!opened) {
      // The item's marker speaks for its own list, so an item whose first block sits in a
      // deeper list gets an empty paragraph of its own first.
      const target = at.replaceAll("|", "").slice(itemPath.length).includes("-")
        ? document.createElement("p")
        : block;
      target.setAttribute("data-marker", marker);
      if (facts.ordered) target.setAttribute("data-kind", "ordered");
      if (facts.start !== null) target.setAttribute("data-start", String(facts.start));
      opened = true;
      if (target !== block) emit(target, itemPath);
    }
    emit(block, at);
  };
  walkBlocks([...item.childNodes], itemPath, own, document);
  if (!opened) own(document.createElement("p"), itemPath);
}

/** The outermost lists and quotes in their sequences, in document order. */
function outermostContainers(root: Element): Element[] {
  return [...root.querySelectorAll(CONTAINERS)].filter((container) => {
    const around = container.parentElement?.closest(`${CONTAINERS}, li, ${SEQUENCE_BOUNDARIES}`);
    return !around || !root.contains(around) || around.matches(SEQUENCE_BOUNDARIES);
  });
}

/**
 * Unwraps every list and quote under `root` into its blocks, each carrying `data-path`, and
 * on an item's first block `data-marker`, `data-kind` and `data-start`. Nesting attributes the
 * source wrote itself are dropped first, so only what this pass read reaches the parser.
 */
export function flattenDom(root: Element): void {
  for (const element of root.querySelectorAll(
    NESTING_DATA_ATTRIBUTES.map((name) => `[${name}]`).join(", "),
  )) {
    for (const name of NESTING_DATA_ATTRIBUTES) element.removeAttribute(name);
  }
  const document = root.ownerDocument;
  // Containers inside a cell are a sequence of their own, reached on a later pass.
  for (let batch = outermostContainers(root); batch.length > 0; batch = outermostContainers(root)) {
    // Each run of adjacent containers is walked together, so a quote after a quote stays apart.
    const runs: Element[][] = [];
    for (const container of batch) {
      const run = runs.at(-1);
      const last = run?.at(-1);
      let sibling = last?.nextSibling ?? null;
      while (sibling && isBlank(sibling)) sibling = sibling.nextSibling;
      if (run && sibling === container) run.push(container);
      else runs.push([container]);
    }
    for (const run of runs) {
      const blocks: Element[] = [];
      walkBlocks(
        run,
        "",
        (block, path) => {
          if (path) block.setAttribute("data-path", path);
          blocks.push(block);
        },
        document,
      );
      run.slice(1).forEach((container) => {
        container.remove();
      });
      run[0].replaceWith(...blocks);
    }
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
    const nested = nodes.some((node) => isNested(node.attrs.path));
    if (!nested || serialized.childNodes.length !== nodes.length) {
      into.appendChild(serialized);
      return into;
    }
    into.append(...nestDom(nestTree(nestNodes(nodes)), [...serialized.childNodes], document));
    return into;
  }
}
