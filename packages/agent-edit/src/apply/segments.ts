/** Write-time grouping policy; review may join segments but never split them. */
import type { DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ResolvedEdit } from "./types.js";

export type SegmentUnit = "edit" | "sentence" | "paragraph";
export const DRAFT_SEGMENT_UNIT: SegmentUnit = "paragraph";

export function editSegments(
  doc: DocHandle,
  model: AgentEditModel,
  edits: readonly ResolvedEdit[],
  unit: SegmentUnit = DRAFT_SEGMENT_UNIT,
): ResolvedEdit[][] {
  const segments: ResolvedEdit[][] = [];
  const blocks = model.getBlocks(doc);
  let structuralEnd: number | undefined;
  for (const edit of edits) {
    if (edit.kind === "textRanges") {
      structuralEnd = undefined;
      const groups = new Map<number, typeof edit.replacements>();
      const text = model.getText(edit.block);
      for (const replacement of edit.replacements) {
        const key =
          unit === "paragraph"
            ? 0
            : unit === "sentence"
              ? (text.slice(0, replacement.span.start).match(/[.!?](?:\s|$)/g)?.length ?? 0)
              : replacement.span.start;
        const group = groups.get(key) ?? [];
        group.push(replacement);
        groups.set(key, group);
      }
      // Earlier offsets survive each independent transaction by executing right to left.
      for (const replacements of [...groups.values()].reverse())
        segments.push([{ ...edit, replacements }]);
    } else if (edit.kind === "block") {
      structuralEnd = undefined;
      segments.push([edit]);
    } else {
      const index =
        edit.kind === "delete"
          ? blocks.indexOf(edit.block)
          : edit.after
            ? blocks.indexOf(edit.after) + 1
            : 0;
      if (structuralEnd !== undefined && index === structuralEnd)
        segments[segments.length - 1].push(edit);
      else segments.push([edit]);
      structuralEnd = edit.kind === "delete" ? index + 1 : index;
    }
  }
  const grouped: ResolvedEdit[][] = [];
  for (const segment of segments) {
    const boundary = segment[0].structuralBoundary;
    const previous = grouped.at(-1);
    if (boundary && previous?.[0].structuralBoundary === boundary) previous.push(...segment);
    else grouped.push(segment);
  }
  return grouped;
}
