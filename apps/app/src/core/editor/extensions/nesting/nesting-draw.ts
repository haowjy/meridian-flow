/**
 * Draws lists and indentation. A list is a run of sibling blocks, so the marker, the number
 * and the indent come from one decoration per block, taken from `nest`'s reading of the
 * siblings, not from wrapper elements. Numbers are drawn with generated content (`data-number`):
 * CSS counters cannot tell where a list restarts among siblings.
 */
import { innermostListStep, nestNodes } from "@meridian/prosemirror-schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

function drawContainer(container: ProseMirrorNode, start: number, out: Decoration[]) {
  const blocks: ProseMirrorNode[] = [];
  const positions: number[] = [];
  let at = start;
  container.forEach((child) => {
    blocks.push(child);
    positions.push(at);
    at += child.nodeSize;
  });
  nestNodes(blocks).forEach((facts, index) => {
    const listSteps = facts.steps.filter((step) => step.type === "list").length;
    if (listSteps === 0) return;
    const attrs: Record<string, string> = {
      class: "meridian-listed",
      style: `--nest-depth: ${listSteps}`,
      // The DOM is flat, so a screen reader learns the depth from the block itself.
      "aria-level": String(listSteps),
    };
    if (facts.marker !== null) {
      const own = facts.steps[innermostListStep(facts.steps)];
      attrs["data-item"] =
        facts.marker === "item"
          ? own.list?.kind === "ordered"
            ? "ordered"
            : "bullet"
          : facts.marker;
      if (own.number !== null) attrs["data-number"] = String(own.number);
    }
    out.push(Decoration.node(positions[index], positions[index] + blocks[index].nodeSize, attrs));
  });
}

function draw(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  drawContainer(doc, 0, decorations);
  doc.descendants((node, pos) => {
    if (node.isTextblock || node.isLeaf) return false;
    if (node.firstChild?.type.spec.group === "block") drawContainer(node, pos + 1, decorations);
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

export function nestingDrawPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: new PluginKey("meridianNestingDraw"),
    state: {
      init: (_config, state) => draw(state.doc),
      apply: (tr, drawn) => (tr.docChanged ? draw(tr.doc) : drawn),
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
