/** Semantic output declarations shared by ordinary writes and identity-addressed revert plans. */
import type { DocumentRevision } from "@meridian/contracts";
import { inlineReplacementText, type ResolvedEdit } from "./apply/types.js";
import { type LineageRange, normalizeLineageRanges } from "./lineage/range-set.js";
import type { AgentEditModel } from "./ports/model.js";
import type { SemanticEditIRV1, SemanticOutputRun } from "./semantic-edit-ir.js";

export function semanticIrForEdits(input: {
  documentId: string;
  inputRevision: DocumentRevision;
  model: AgentEditModel;
  edits: readonly ResolvedEdit[];
}): SemanticEditIRV1 {
  const { edits, model, documentId, inputRevision } = input;
  const scope: LineageRange[] = [];
  const deleted: LineageRange[] = [];
  const mappedEdits = edits.map((edit) => {
    let outputRuns: SemanticOutputRun[] = [];
    if (edit.kind === "textRanges") {
      const lineage = model.getVisibleContentLineage(edit.block);
      scope.push(...lineage);
      for (const replacement of edit.replacements) {
        deleted.push(...sliceLineage(lineage, replacement.span.start, replacement.span.end));
      }
      outputRuns = semanticRunsForTextRanges(lineage, edit);
    } else if (edit.kind === "insert") {
      if (edit.newText.length > 0) {
        outputRuns = [
          {
            kind: "fresh",
            payload: edit.newText,
            output: { from: 0, to: edit.newText.length },
          },
        ];
      }
    } else {
      const lineage = model.getVisibleContentLineage(edit.block);
      scope.push(...lineage);
      deleted.push(...lineage);
      if (edit.kind === "block" && edit.replacement.textContent.length > 0) {
        outputRuns = [
          {
            kind: "fresh",
            payload: edit.replacement.textContent,
            output: { from: 0, to: edit.replacement.textContent.length },
          },
        ];
      }
    }
    return { edit, outputRuns };
  });

  return {
    version: 1,
    documentId,
    inputRevision,
    scope: normalizeLineageRanges(scope),
    deleted: normalizeLineageRanges(deleted),
    intent: { kind: "mappedEdits", edits: mappedEdits },
  };
}

function semanticRunsForTextRanges(
  lineage: readonly LineageRange[],
  edit: Extract<ResolvedEdit, { kind: "textRanges" }>,
): SemanticOutputRun[] {
  const first = edit.replacements[0];
  if (!first) return [];
  const runs: SemanticOutputRun[] = [];
  let sourceCursor = first.span.start;
  let outputCursor = 0;
  for (const replacement of edit.replacements) {
    for (const source of sliceLineage(lineage, sourceCursor, replacement.span.start)) {
      runs.push({
        kind: "preserved",
        source,
        output: { from: outputCursor, to: outputCursor + source.length },
        materialization: "retained",
      });
      outputCursor += source.length;
    }
    const text = inlineReplacementText(replacement);
    if (text.length > 0) {
      runs.push({
        kind: "fresh",
        payload: text,
        output: { from: outputCursor, to: outputCursor + text.length },
      });
      outputCursor += text.length;
    }
    sourceCursor = replacement.span.end;
  }
  return runs;
}

function sliceLineage(lineage: readonly LineageRange[], from: number, to: number): LineageRange[] {
  const slices: LineageRange[] = [];
  let cursor = 0;
  for (const range of lineage) {
    const start = Math.max(from, cursor);
    const end = Math.min(to, cursor + range.length);
    if (start < end) {
      slices.push({
        clientID: range.clientID,
        clock: range.clock + start - cursor,
        length: end - start,
      });
    }
    cursor += range.length;
  }
  return slices;
}
