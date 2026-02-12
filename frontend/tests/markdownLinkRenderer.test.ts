import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { parser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { linkRenderer } from "@/core/editor/codemirror/livePreview/renderers/link";
import { useTreeStore } from "@/core/stores/useTreeStore";

function firstLinkNode(doc: string): SyntaxNode {
  const tree = parser.parse(doc);
  let linkNode: SyntaxNode | null = null;

  tree.iterate({
    enter(node) {
      if (linkNode) return false;
      if (node.name === "Link") {
        linkNode = node.node;
        return false;
      }
      return undefined;
    },
  });

  if (!linkNode) {
    throw new Error(`Expected a Link node in doc: ${doc}`);
  }

  return linkNode;
}

function renderFirstLink(doc: string) {
  const state = EditorState.create({
    doc,
    // Keep cursor far from link so renderer does not early-return on adjacency.
    selection: { anchor: 0 },
  });
  const node = firstLinkNode(doc);
  const decorations = linkRenderer.render(node, {
    state,
    cursorWords: [],
    excludedRegions: [],
  });
  return { node, decorations };
}

describe("markdown link renderer edge cases", () => {
  beforeEach(() => {
    useTreeStore.setState({ documents: [], folders: [] });
  });

  it("keeps simple-link styling for empty URL target [a]()", () => {
    const { node, decorations } = renderFirstLink("p [a]() q");

    expect(decorations).toHaveLength(3);
    expect(decorations[0]?.from).toBe(node.from);
    expect(decorations[0]?.to).toBe(node.from + 1);
    expect((decorations[1]?.deco as { spec?: { class?: string } }).spec?.class).toBe(
      "cm-link",
    );
  });

  it("skips malformed inline link syntax without URL node ([a](x y))", () => {
    const { decorations } = renderFirstLink("p [a](x y) q");
    expect(decorations).toHaveLength(0);
  });

  it("skips reference-style links ([a][ref]) for live preview link renderer", () => {
    const { decorations } = renderFirstLink("p [a][ref] q");
    expect(decorations).toHaveLength(0);
  });

  it("still renders external widget when URL is angle-bracket form", () => {
    const { node, decorations } = renderFirstLink("p [a](<https://example.com>) q");

    expect(decorations).toHaveLength(1);
    expect(decorations[0]?.from).toBe(node.from);
    expect(decorations[0]?.to).toBe(node.to);
    const widget = (decorations[0]?.deco as { spec?: { widget?: unknown } }).spec
      ?.widget;
    expect(widget).toBeDefined();
  });
});
