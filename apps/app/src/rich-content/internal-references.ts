/**
 * Finding the references a writer put in a message.
 *
 * A chat message is plain markdown, and `[[The Third Gate]]` is not a markdown
 * construct — remark leaves it as literal text, which is exactly why the
 * spelling costs nothing on the wire. This is the transform that reads it back:
 * over every text node the parser produced, the two internal spellings become
 * link nodes, and everything else is left alone.
 *
 * **Which spellings, and why not a list of them.** `[[Title]]` and a URI whose
 * scheme addresses a project document — asked of
 * [`classifyLinkTarget`](../core/links/link-target.ts) rather than matched
 * against a list copied out of it, so a scheme added there is a scheme the
 * transcript reads on the same day.
 *
 * **They are not anchors.** The reference carries a `manuscript://` target,
 * and the markdown sanitizer refuses that protocol in an `href` — correctly,
 * since it has no idea what our schemes are. So the node renders as an element
 * of our own, which leaves the anchor renderer, and therefore every ordinary
 * link in a message, completely untouched.
 *
 * **One markdown construct joins the two spellings**: a real link whose URL is
 * an internal scheme — `[fight.png](uploads://fight.png)`, the composer's
 * spelling for a pasted upload. Left alone it would reach the sanitizer as an
 * anchor on a refused protocol and render as the writer's filename plus a
 * "[blocked]" scar. It becomes the same reference element, keeping the link's
 * own text as the display. Relative and web URLs stay ordinary links.
 */

import { classifyLinkTarget, isInternalLinkTarget, linkTargetHref } from "@/core/links";

/** The element an internal reference renders as. */
export const REFERENCE_TAG = "meridian-reference";

/**
 * Where the target rides, under its two names: the sanitizer's allowlist is
 * keyed by hast property, and the renderer sees the DOM attribute that property
 * becomes.
 *
 * A `data-` attribute rather than an obvious one, and not by taste: the
 * sanitizer prefixes `name` and `id` with `user-content-` to stop a document
 * from clobbering the page's own ids, which would silently turn every target
 * into a different string.
 */
export const REFERENCE_TARGET_PROPERTY = "dataTarget";
export const REFERENCE_TARGET_ATTRIBUTE = "data-target";

/** Only what this transform reads. The tree carries far more, and it may. */
type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
};

/**
 * `[[Title]]`, or a scheme URI running to the first whitespace. The URI arm is
 * deliberately greedy about punctuation and then trimmed: a URI genuinely may
 * end in a bracket, and a sentence genuinely may end in a full stop.
 */
const REFERENCE = /\[\[([^[\]|\r\n]+)\]\]|([a-z][a-z\d+.-]*:\/\/\S+)/gi;

/** Sentence punctuation a URI picked up by running to the whitespace. */
const TRAILING = /[.,;:!?)\]}'"»”]+$/;

/**
 * Nodes whose text is not prose. Code is source, and a link already points
 * somewhere — a reference inside one would be a link inside a link.
 */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference", "definition", "html"]);

/** A remark plugin. Runs after gfm, so an autolinked URL is already a link. */
export function remarkInternalReferences() {
  return (tree: MdastNode) => {
    transform(tree);
  };
}

function transform(node: MdastNode): void {
  const children = node.children;
  if (!children || OPAQUE.has(node.type)) return;

  let index = 0;
  while (index < children.length) {
    const child = children[index];
    if (!child) break;
    const split = child.type === "text" ? referenceNodes(child.value ?? "") : null;
    if (split) {
      children.splice(index, 1, ...split);
      index += split.length;
      continue;
    }
    const internal = child.type === "link" ? internalLinkReference(child) : null;
    if (internal) {
      children.splice(index, 1, internal);
      index += 1;
      continue;
    }
    transform(child);
    index += 1;
  }
}

/**
 * A markdown link whose URL is one of our schemes, rebuilt as a reference —
 * or null for every link that belongs to the web (or to a relative path,
 * which the anchor renderer already owns).
 */
function internalLinkReference(node: MdastNode): MdastNode | null {
  const url = node.url ?? "";
  const target = url ? classifyLinkTarget(url) : null;
  if (!target || target.kind !== "scheme") return null;
  const text = flattenedText(node);
  return reference(linkTargetHref(target), text || url);
}

/** The link's visible text, whatever inline nodes it was written with. */
function flattenedText(node: MdastNode): string {
  if (node.value) return node.value;
  return (node.children ?? []).map(flattenedText).join("");
}

/** The text broken into plain runs and references, or null when it holds none. */
function referenceNodes(value: string): MdastNode[] | null {
  const nodes: MdastNode[] = [];
  let cursor = 0;

  REFERENCE.lastIndex = 0;
  for (let match = REFERENCE.exec(value); match; match = REFERENCE.exec(value)) {
    const [whole, name, uri] = match;
    const spelling = name === undefined ? trimmed(uri ?? "") : whole;
    const target = classifyLinkTarget(spelling);
    if (!target || !isInternalLinkTarget(target)) {
      // A URI on a scheme we do not own is an ordinary word here; gfm already
      // decided whether it was a link.
      REFERENCE.lastIndex = match.index + spelling.length;
      continue;
    }

    if (match.index > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    nodes.push(reference(linkTargetHref(target), name === undefined ? spelling : name));
    cursor = match.index + spelling.length;
    REFERENCE.lastIndex = cursor;
  }

  if (nodes.length === 0) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

/**
 * The display text is what the writer typed: a title reads as prose, and a URI
 * stays a URI rather than quietly becoming a name the message never carried.
 */
function reference(target: string, text: string): MdastNode {
  return {
    type: "link",
    // The link handler normalizes a URL before anything can override the
    // element, so the empty one is load-bearing: our target rides an attribute
    // of its own, and an empty `href` is dropped by the sanitizer.
    url: "",
    children: [{ type: "text", value: text }],
    data: {
      hName: REFERENCE_TAG,
      hProperties: { [REFERENCE_TARGET_PROPERTY]: target },
    },
  };
}

function trimmed(uri: string): string {
  return uri.replace(TRAILING, "");
}
