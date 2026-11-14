/** Tool-owned document-text substitutions; the compaction planner decides staleness. */
import { documentPathKey, splitDocumentHrefSuffix } from "@meridian/contracts";
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import {
  type GrepToolResult,
  isGrepResult,
  renderGrepFileList,
  renderGrepFiles,
} from "./grep-result.js";

/**
 * `stale`: the document changed since this copy. `reshown`: compaction shows its
 * current text after the summary, so this copy is a duplicate. `history`: a
 * `thread_history` stub.
 */
export type DocumentTextTreatment = "stale" | "reshown" | "history";
export type DocumentRef = Pick<DocumentRevisionEvidence, "documentId" | "uri">;
export interface DocumentTextPolicy {
  /** Whether the tool's results hold document text it read or text it wrote. */
  kind: "read" | "write";
  /**
   * `result` is the typed value the stored `content` was rendered from. The returned `text`
   * replaces the whole `content`, so a media part in it goes with the text it came with.
   */
  elide(
    block: { input?: JsonObject; result?: JsonValue },
    changed: readonly DocumentRef[],
    treatment: DocumentTextTreatment,
  ): { input?: JsonObject; text: string };
}

export function reshownReadStub(documents: string): string {
  return `[Cleared at compaction: the current text of ${documents} is shown after the summary.]`;
}

export function staleReadStub(documents: string): string {
  return `[Cleared at compaction: ${documents} has changed since this read. Read it again before relying on its text.]`;
}

function documentsLabel(changed: readonly DocumentRef[], input: JsonObject): string {
  const { path, suffix } = splitDocumentHrefSuffix(String(input.path ?? "This document"));
  return (
    changed.map((ref) => ref.uri ?? ref.documentId).join(", ") || documentPathKey(path) + suffix
  );
}

function readStub(documents: string, treatment: DocumentTextTreatment): string {
  return treatment === "history"
    ? historyReadStub(documents)
    : treatment === "reshown"
      ? reshownReadStub(documents)
      : staleReadStub(documents);
}

export const readDocumentText: DocumentTextPolicy = {
  kind: "read",
  elide({ input = {} }, changed, treatment) {
    const documents = documentsLabel(changed, input);
    return { text: readStub(documents, treatment) };
  },
};

export const writeDocumentText: DocumentTextPolicy = {
  kind: "write",
  elide({ input = {} }, changed, treatment) {
    const documents = documentsLabel(changed, input);
    if (treatment === "history") {
      return { text: `[edit applied to ${documents} (${input.command})]` };
    }
    const { content: _content, find: _find, around: _around, ...kept } = input;
    return {
      ...(["create", "insert", "replace"].includes(String(input.command)) ? { input: kept } : {}),
      text:
        treatment === "reshown"
          ? `[Cleared at compaction: you edited ${documents} here (${input.command}); its current text is shown after the summary.]`
          : `[Cleared at compaction: you edited ${documents} here (${input.command}); it has changed since. Read it before relying on this edit.]`,
    };
  },
};

/** A grep's passages from changed files are cleared; its history form keeps files and counts. */
export const grepDocumentText: DocumentTextPolicy = {
  kind: "read",
  elide({ input = {}, result }, changed, treatment) {
    if (!isGrepResult(result))
      return { text: `[Cleared at compaction: grep results; grep again for current text]` };
    const grepped = result as unknown as GrepToolResult;
    if (treatment === "history") return { text: renderGrepFileList(grepped) };
    const uris = new Set(changed.map((ref) => ref.uri));
    return {
      text: renderGrepFiles(grepped, input, (hit) => changed.length === 0 || uris.has(hit.uri)),
    };
  },
};

export function historyReadStub(documents: string): string {
  return `[omitted: ${documents}; read it for current text]`;
}

export const historyDocumentText: DocumentTextPolicy = {
  kind: "read",
  elide(_block, documents, treatment) {
    return {
      text:
        treatment === "history"
          ? "[thread_history output omitted]"
          : `[Cleared at compaction: thread_history output quoting edits to ${documents.map((ref) => ref.uri ?? ref.documentId).join(", ") || "documents"}. Call thread_history again.]`,
    };
  },
};
