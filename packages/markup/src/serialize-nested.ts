import {
  type BlockFacts,
  innermostListStep,
  type ListFacts,
  nestNodes,
} from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";

export type SerializedBlock = {
  body: string;
  gap: string;
  open: string;
};

export function serializeNested(
  blocks: readonly PMNode[],
  bodyOf: (block: PMNode, facts: BlockFacts) => string,
): SerializedBlock[] {
  const facts = nestNodes(blocks);
  const bodies = blocks.map((block, index) => bodyOf(block, facts[index]));
  const delimiters = new Map<ListFacts, string>();
  const ruleLists = new Set<ListFacts>();
  facts.forEach((block, index) => {
    const at = innermostListStep(block.steps);
    if (block.marker !== null && blocks[index].type.name === "horizontal_rule") {
      ruleLists.add(block.steps[at].list as ListFacts);
    }
  });

  const delimiterFor = (index: number, step: number): string => {
    const list = facts[index].steps[step].list as ListFacts;
    const known = delimiters.get(list);
    if (known) return known;
    const ordered = list.kind === "ordered";
    let delimiter = ordered ? "." : "-";
    const previous = facts[index - 1]?.steps[step];
    const follows =
      previous?.type === "list" &&
      previous.list !== list &&
      facts[index].steps.slice(0, step).every((outer) => !outer.opens);
    const lastUsed = follows ? delimiters.get(previous.list as ListFacts) : undefined;
    if (lastUsed === delimiter || (!ordered && delimiter === "-" && ruleLists.has(list))) {
      delimiter = ordered ? ")" : "*";
    }
    delimiters.set(list, delimiter);
    return delimiter;
  };

  const markerOf = (index: number, step: number): string => {
    const at = facts[index].steps[step];
    const delimiter = delimiterFor(index, step);
    return at.number === null ? `${delimiter} ` : `${at.number}${delimiter} `;
  };

  const prefixOf = (index: number, upTo: number, first: boolean, every = false): string =>
    facts[index].steps
      .slice(0, upTo)
      .map((step, k) => {
        if (step.type === "quote") return "> ";
        const marker = markerOf(index, k);
        return every || (first && (step.opens || step.startsItem))
          ? marker
          : " ".repeat(marker.length);
      })
      .join("");

  return blocks.map((block, index) => {
    const own = facts[index];
    own.steps.forEach((step, k) => {
      if (step.type === "list") delimiterFor(index, k);
    });
    const task = own.marker === "todo" ? "[ ] " : own.marker === "done" ? "[x] " : "";
    const first = prefixOf(index, own.steps.length, true) + task;
    const rest = prefixOf(index, own.steps.length, false);
    const body = bodies[index]
      .split("\n")
      .map((line, row) => {
        const prefix = row === 0 ? first : rest;
        return line === "" ? prefix.trimEnd() : prefix + line;
      })
      .join("\n");
    const open = prefixOf(index, own.steps.length, true, true);
    if (index === 0) return { body, gap: "", open };

    const shared = own.steps.filter((step) => !step.opens).length - 1;
    if (shared < 0) return { body, gap: "\n\n", open };
    const step = own.steps[shared];
    const tight =
      step.type === "list" &&
      (step.startsItem
        ? !(step.list as ListFacts).loose
        : joinsDirectly(blocks[index - 1], block, facts[index - 1], own, shared, bodies[index]));
    return {
      body,
      gap: tight ? "\n" : `\n${prefixOf(index, shared + 1, false).trimEnd()}\n`,
      open,
    };
  });
}

function joinsDirectly(
  before: PMNode,
  block: PMNode,
  beforeFacts: BlockFacts,
  facts: BlockFacts,
  shared: number,
  body: string,
): boolean {
  const type = before.type.name;
  if (type === "code_block" || type === "horizontal_rule") return true;
  if (type === "paragraph" && before.attrs.level != null) return true;
  const opened = facts.steps.slice(shared + 1);
  if (opened.length > 0) {
    // Every container the block opens on its first line counts as interrupting the item's
    // paragraph, so a numbered list there must start at 1.
    if (opened[0].type === "quote" && beforeFacts.steps[shared + 1]?.type === "quote") return false;
    return (
      body.split("\n")[0] !== "" &&
      opened.every(
        (step) =>
          step.type === "quote" ||
          (step.list as ListFacts).kind === "bullet" ||
          (step.list as ListFacts).start === 1,
      )
    );
  }
  const name = block.type.name;
  if (name === "code_block") return true;
  if (name === "paragraph" && block.attrs.level != null) return true;
  return body.startsWith("<table>");
}
