/** Inject only F5-authorized reference occurrence source ranges into Markdown AST. */
export type MarkdownReferenceOccurrence = {
  from: number;
  to: number;
  documentId: string;
  uri: string;
};
export const REFERENCE_TAG = "meridian-reference";
type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, string> };
};
export function remarkReferenceOccurrences(occurrences: readonly MarkdownReferenceOccurrence[]) {
  return () => (tree: Node) => transform(tree, occurrences);
}
function transform(node: Node, occurrences: readonly MarkdownReferenceOccurrence[]): void {
  if (!node.children) return;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (!child) continue;
    if (
      child.type !== "text" ||
      child.value === undefined ||
      child.position?.start.offset === undefined
    ) {
      transform(child, occurrences);
      continue;
    }
    const start = child.position.start.offset;
    const end = start + child.value.length;
    const within = occurrences.filter((item) => item.from >= start && item.to <= end);
    if (!within.length) continue;
    const split: Node[] = [];
    let cursor = start;
    for (const item of within) {
      if (item.from > cursor)
        split.push({ type: "text", value: child.value.slice(cursor - start, item.from - start) });
      split.push({
        type: "referenceOccurrence",
        value: child.value.slice(item.from - start, item.to - start),
        data: {
          hName: REFERENCE_TAG,
          hProperties: { dataDocumentId: item.documentId, dataUri: item.uri },
        },
        children: [{ type: "text", value: child.value.slice(item.from - start, item.to - start) }],
      });
      cursor = item.to;
    }
    if (cursor < end) split.push({ type: "text", value: child.value.slice(cursor - start) });
    node.children.splice(index, 1, ...split);
    index += split.length - 1;
  }
}
