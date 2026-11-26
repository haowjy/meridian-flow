import { detach, innermostListStep, pathOf, readPath } from "@meridian/prosemirror-schema";
import type { Block } from "../codec-types.js";

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
