import ts from "@typescript/typescript6";

export function parseSource(filePath, text) {
  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : filePath.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(filePath)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
}

// The raw scanner loses its place after a template with a substitution, so comments come from the parse tree, and JsxText is skipped because its words are text
export function sourceComments(sourceFile, text) {
  const byStart = new Map();
  // A truthy return stops the scan after the first comment of a run.
  const add = (pos, end) => {
    byStart.set(pos, { end, start: pos, text: text.slice(pos, end) });
  };
  function visit(node) {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    if (node.getChildCount(sourceFile) === 0) {
      ts.forEachLeadingCommentRange(text, node.pos, add);
      ts.forEachTrailingCommentRange(text, node.end, add);
      return;
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  }
  visit(sourceFile);
  return [...byStart.values()].sort((left, right) => left.start - right.start);
}
