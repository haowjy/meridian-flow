/**
 * Newlines that mean line breaks, for text where the writer put them.
 *
 * Commonmark reads a lone `\n` inside a paragraph as a soft break and renders
 * it as a space — right for markdown an author wrapped by hand, wrong for a
 * sent chat message, where the composer serializes Shift+Enter as exactly
 * that `\n`. This transform is the small remark plugin that keeps the
 * writer's break visible: every newline still sitting in a text node after
 * parsing becomes a `break` node, which renders as `<br>`.
 *
 * Text nodes only, which is the safety: code and inline code carry their
 * content in `value` leaves this walk never touches, and everything markdown
 * already recognized as structure (paragraphs split on `\n\n`, lists, block
 * quotes) was consumed by the parser before this runs.
 */

/** Only what this transform reads; the tree carries far more, and it may. */
type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
};

export function remarkLineBreaks() {
  return (tree: MdastNode) => {
    transform(tree);
  };
}

function transform(node: MdastNode): void {
  const children = node.children;
  if (!children) return;

  let index = 0;
  while (index < children.length) {
    const child = children[index];
    if (!child) break;
    const split = child.type === "text" ? breakNodes(child.value ?? "") : null;
    if (split) {
      children.splice(index, 1, ...split);
      index += split.length;
      continue;
    }
    transform(child);
    index += 1;
  }
}

/** The text split around its newlines, or null when it holds none. */
function breakNodes(value: string): MdastNode[] | null {
  if (!/[\r\n]/.test(value)) return null;
  const nodes: MdastNode[] = [];
  const runs = value.split(/\r?\n|\r/);
  runs.forEach((run, position) => {
    if (position > 0) nodes.push({ type: "break" });
    if (run) nodes.push({ type: "text", value: run });
  });
  return nodes;
}
