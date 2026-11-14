/**
 * Draws lists and quotes. Both are runs of sibling blocks, so the indent, the quote bars, the
 * marker and the number come from one decoration per block, taken from `nest`'s reading of
 * the siblings, not from wrapper elements. Numbers are drawn with generated content
 * (`data-number`): CSS counters cannot tell where a list restarts among siblings.
 */
import {
  type BlockFacts,
  innermostListStep,
  nestNodes,
  type StepFacts,
} from "@meridian/prosemirror-schema";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** The inline offset where `steps` end, in the step widths `editor.css` defines. */
function offset(steps: readonly StepFacts[]): string {
  const lists = steps.filter((step) => step.type === "list").length;
  const quotes = steps.length - lists;
  return `calc(${lists} * var(--nest-list-step) + ${quotes} * var(--nest-quote-step))`;
}

/** True when the block continues a quote the block before it is in. */
function joinsQuoteAbove(facts: BlockFacts | undefined): boolean {
  return facts?.steps.some((step) => step.type === "quote" && !step.opens) ?? false;
}

/**
 * One bar per quote step. Blocks of one quote meet through their padding, so a bar runs
 * through the gap to the next block of its quote and stops short of it otherwise.
 */
function quoteBars(
  facts: BlockFacts,
  next: BlockFacts | undefined,
  above: boolean,
  below: boolean,
) {
  const images: string[] = [];
  const positions: string[] = [];
  const sizes: string[] = [];
  facts.steps.forEach((step, k) => {
    if (step.type !== "quote") return;
    const top = step.opens && above ? "var(--nest-join-pad)" : "0px";
    const continues = next?.steps[k]?.type === "quote" && !next.steps[k].opens;
    const bottom = !continues && below ? "var(--nest-join-pad)" : "0px";
    images.push("linear-gradient(var(--nest-bar), var(--nest-bar))");
    positions.push(`${offset(facts.steps.slice(0, k))} ${top}`);
    sizes.push(`var(--nest-bar-width) calc(100% - ${top} - ${bottom})`);
  });
  return `background-image: ${images.join(", ")}; background-position: ${positions.join(", ")}; background-size: ${sizes.join(", ")};`;
}

function drawContainer(container: ProseMirrorNode, start: number, out: Decoration[]) {
  const blocks: ProseMirrorNode[] = [];
  const positions: number[] = [];
  let at = start;
  container.forEach((child) => {
    blocks.push(child);
    positions.push(at);
    at += child.nodeSize;
  });
  const all = nestNodes(blocks);
  all.forEach((facts, index) => {
    if (facts.steps.length === 0) return;
    const listSteps = facts.steps.filter((step) => step.type === "list").length;
    const quoted = listSteps < facts.steps.length;
    const innermostList = innermostListStep(facts.steps);
    const classes = ["meridian-nested"];
    let style = `--nest-indent: ${offset(facts.steps)};`;
    const attrs: Record<string, string> = {};
    if (listSteps > 0) {
      classes.push("meridian-listed");
      style += ` --nest-marker: ${offset(facts.steps.slice(0, innermostList + 1))};`;
      // The DOM is flat, so a screen reader learns the depth from the block itself.
      attrs["aria-level"] = String(listSteps);
    }
    if (quoted) {
      const above = joinsQuoteAbove(facts);
      const below = joinsQuoteAbove(all[index + 1]);
      classes.push("meridian-quoted");
      if (above || below) {
        attrs["data-quote-join"] = [above && "above", below && "below"].filter(Boolean).join(" ");
      }
      style += ` ${quoteBars(facts, all[index + 1], above, below)}`;
    }
    if (facts.marker !== null) {
      const own = facts.steps[innermostList];
      attrs["data-item"] =
        facts.marker === "item"
          ? own.list?.kind === "ordered"
            ? "ordered"
            : "bullet"
          : facts.marker;
      if (own.number !== null) attrs["data-number"] = String(own.number);
    }
    out.push(
      Decoration.node(positions[index], positions[index] + blocks[index].nodeSize, {
        ...attrs,
        class: classes.join(" "),
        style,
      }),
    );
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
