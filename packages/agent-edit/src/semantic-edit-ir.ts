// Validated semantic intent at the resolver-to-ProseMirror certification seam.

import type { DocumentRevision } from "@meridian/contracts";
import type { ResolvedEdit } from "./apply/types.js";
import type { LineageRange } from "./lineage/range-set.js";
import { lineageRangesContain, normalizeLineageRanges } from "./lineage/range-set.js";

export type Utf16Span = { from: number; to: number };

export type SemanticOutputRun =
  | { kind: "preserved"; source: LineageRange; output: Utf16Span }
  | { kind: "fresh"; payload: string; output: Utf16Span }
  | { kind: "copy"; source: LineageRange; payload: string; output: Utf16Span }
  | { kind: "restoration"; root: LineageRange; payload: string; output: Utf16Span };

export type SemanticEditIRV1 = {
  version: 1;
  documentId: string;
  inputRevision: DocumentRevision;
  scope: LineageRange[];
  intent:
    | {
        kind: "mappedEdits";
        edits: Array<{ edit: ResolvedEdit; outputRuns: SemanticOutputRun[] }>;
      }
    | { kind: "fullScopeFreshReplacement"; payload: string };
  deleted: LineageRange[];
};

export type RestorationCertificatePort = {
  hasRetainedRoot(documentId: string, root: LineageRange): boolean;
};

/**
 * Validate the complete resolver declaration before any lowering mutates a PM or Yjs document.
 * This is deliberately strict: missing output, overlap, a split surrogate, or an unbound source
 * rejects rather than silently becoming fresh authorship.
 */
export function validateSemanticEditIRV1(
  ir: SemanticEditIRV1,
  options: {
    expectedDocumentId: string;
    expectedInputRevision: DocumentRevision;
    restorationCertificates?: RestorationCertificatePort;
  },
): SemanticEditIRV1 {
  if (ir.version !== 1) throw new Error("Unsupported semantic edit IR version");
  if (ir.documentId !== options.expectedDocumentId) {
    throw new Error("Semantic edit IR belongs to a different document");
  }
  if (ir.inputRevision !== options.expectedInputRevision) {
    throw new Error("Semantic edit IR input revision is stale");
  }
  const scope = normalizeLineageRanges(ir.scope);
  const deleted = normalizeLineageRanges(ir.deleted);
  for (const range of deleted) {
    if (!lineageRangesContain(scope, range)) throw new Error("Deleted range is outside IR scope");
  }
  if (ir.intent.kind === "fullScopeFreshReplacement") {
    if (!sameRanges(scope, deleted)) {
      throw new Error("Full-scope fresh replacement must delete the complete declared scope");
    }
    assertUtf16Boundary(ir.intent.payload, 0);
    assertUtf16Boundary(ir.intent.payload, ir.intent.payload.length);
    return ir;
  }

  for (const declared of ir.intent.edits) {
    if (declared.edit.documentId !== ir.documentId) {
      throw new Error("Resolved edit belongs to a different document");
    }
    const output = editOutput(declared.edit);
    validateOutputPartition(output, declared.outputRuns);
    for (const run of declared.outputRuns) {
      if (run.kind === "preserved" || run.kind === "copy") {
        if (!lineageRangesContain(scope, run.source)) {
          throw new Error(`${run.kind} source is outside IR scope`);
        }
        if (run.kind === "preserved" && spanLength(run.output) !== run.source.length) {
          throw new Error("Preserved output must map length-for-length to its source root offsets");
        }
      }
      if (run.kind === "restoration") {
        if (!options.restorationCertificates?.hasRetainedRoot(ir.documentId, run.root)) {
          throw new Error("Restoration requires a retained root certificate");
        }
      }
      if (run.kind !== "preserved") {
        const rendered = output.slice(run.output.from, run.output.to);
        if (rendered !== run.payload) throw new Error(`${run.kind} payload does not match output`);
      }
    }
  }
  return ir;
}

export function validateOutputPartition(output: string, runs: readonly SemanticOutputRun[]): void {
  const ordered = [...runs].sort(
    (left, right) => left.output.from - right.output.from || left.output.to - right.output.to,
  );
  let cursor = 0;
  for (const run of ordered) {
    const { from, to } = run.output;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
      throw new Error("Semantic output spans must be non-empty half-open UTF-16 ranges");
    }
    if (from !== cursor) {
      throw new Error(
        from < cursor ? "Semantic output spans overlap" : "Semantic output is unclaimed",
      );
    }
    if (to > output.length) throw new Error("Semantic output span exceeds edit output");
    assertUtf16Boundary(output, from);
    assertUtf16Boundary(output, to);
    cursor = to;
  }
  if (cursor !== output.length) throw new Error("Semantic output is unclaimed");
  if (output.length === 0 && runs.length > 0)
    throw new Error("Empty output cannot have semantic runs");
}

function editOutput(edit: ResolvedEdit): string {
  switch (edit.kind) {
    case "text":
    case "insert":
      return edit.newText;
    case "block":
      return edit.replacement.textContent;
    case "delete":
      return "";
  }
}

function assertUtf16Boundary(value: string, offset: number): void {
  if (offset <= 0 || offset >= value.length) return;
  const before = value.charCodeAt(offset - 1);
  const after = value.charCodeAt(offset);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
    throw new Error("Semantic output span splits a UTF-16 surrogate pair");
  }
}

function spanLength(span: Utf16Span): number {
  return span.to - span.from;
}

function sameRanges(left: readonly LineageRange[], right: readonly LineageRange[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        range.clientID === right[index]?.clientID &&
        range.clock === right[index]?.clock &&
        range.length === right[index]?.length,
    )
  );
}
