import { detach, innermostListStep, pathOf, readPath } from "@meridian/prosemirror-schema";
import type { Block } from "../codec-types.js";

/**
 * Copied blocks as they sit where they land: each loses the steps they shared in the source
 * document (`detach`), then takes the containers around `beside`, the block they land next to
 * (null at the top). A block with a list level of its own lands as an item beside `beside`'s
 * list level; one without lands in the same containers, so a copied paragraph never joins a
 * list it was not an item of.
 */
export function landCopies(copies: readonly Block[], beside: Block | null): Block[] {
  const own = detach(copies.map((block) => readPath(block.attrs.path)));
  const around = readPath(beside?.attrs.path).map((step) => ({ ...step, fresh: false }));
  const list = innermostListStep(around);
  const base = list < 0 ? around : around.slice(0, list);
  return copies.map((block, index) => {
    const steps = [...base, ...own[index]];
    const attrs: Record<string, unknown> = { ...block.attrs, path: pathOf(steps) };
    if (!steps.some((step) => step.type === "list")) {
      Object.assign(attrs, { kind: null, marker: null, start: null, loose: null });
    }
    return block.type.create(attrs, block.content, block.marks);
  });
}
