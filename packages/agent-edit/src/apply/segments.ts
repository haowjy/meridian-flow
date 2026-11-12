/** Write-time grouping policy; review may join segments but never split them. */
import type { DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ResolvedEdit } from "./types.js";

export function editSegments(
  doc: DocHandle,
  model: AgentEditModel,
  edits: readonly ResolvedEdit[],
): ResolvedEdit[][] {
  const segments: ResolvedEdit[][] = [];
  const blocks = model.getBlocks(doc);
  let structuralEnd: number | undefined;
  for (const edit of edits) {
    if (edit.kind === "ops" || edit.kind === "block") {
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
