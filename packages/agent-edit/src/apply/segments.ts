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
  // Moving prose across a paragraph boundary is one split/merge, unlike a new adjacent run.
  const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
  for (let index = 0; index < segments.length - 1; index++) {
    const left = segments[index],
      right = segments[index + 1];
    const splices = [...left, ...right].filter((edit) => edit.kind === "textRanges");
    const structure = [...left, ...right].filter(
      (edit) => edit.kind === "insert" || edit.kind === "delete",
    );
    const movesProse = splices.some((splice) =>
      structure.some((edit) => {
        const structuralText = normalized(
          edit.kind === "insert"
            ? edit.blocks.map((block) => block.textContent).join(" ")
            : model.getText(edit.block),
        );
        if (!structuralText) return false;
        const moved = normalized(
          splice.replacements
            .map((replacement) =>
              edit.kind === "insert"
                ? model.getText(splice.block).slice(replacement.span.start, replacement.span.end)
                : replacement.content.textBetween(0, replacement.content.size, ""),
            )
            .join(" "),
        );
        return moved.includes(structuralText);
      }),
    );
    if (movesProse) {
      left.push(...right);
      segments.splice(index + 1, 1);
      index--;
    }
  }
  return segments;
}
