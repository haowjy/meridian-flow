/** Tool-owned document-text substitutions; the compaction planner decides staleness. */
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import {
  isSearchHits,
  renderSearchFiles,
  renderSearchHits,
  type SearchHit,
} from "./search-result.js";

export type DocumentRef = Pick<DocumentRevisionEvidence, "documentId" | "uri">;
export interface DocumentTextPolicy {
  /** Whether the tool's results hold document text it read or text it wrote. */
  kind: "read" | "write";
  /** `output` is what the model read; `result` the typed value beside it (D43), when stored. */
  elide(
    block: { input?: JsonObject; output?: JsonValue; result?: JsonValue },
    changed: readonly DocumentRef[],
    treatment: "stale" | "history",
  ): { input?: JsonObject; output?: JsonValue };
}

export function staleReadStub(documents: string): string {
  return `[Cleared at compaction: ${documents} has changed since this read. Read it again before relying on its text.]`;
}

function documentsLabel(changed: readonly DocumentRef[], input: JsonObject): string {
  return (
    changed.map((ref) => ref.uri ?? ref.documentId).join(", ") ||
    String(input.path ?? "This document")
  );
}

export const readDocumentText: DocumentTextPolicy = {
  kind: "read",
  elide({ input = {} }, changed, treatment) {
    const documents = documentsLabel(changed, input);
    return {
      output: treatment === "history" ? historyReadStub(documents) : staleReadStub(documents),
    };
  },
};

export const writeDocumentText: DocumentTextPolicy = {
  kind: "write",
  elide({ input = {}, output }, changed, treatment) {
    const documents = documentsLabel(changed, input);
    if (treatment === "history") {
      return { output: `[edit applied to ${documents} (${input.command})]` };
    }
    const { content: _content, find: _find, around: _around, ...kept } = input;
    return {
      ...(["create", "insert", "replace"].includes(String(input.command)) ? { input: kept } : {}),
      ...(output !== undefined
        ? {
            output: `[Cleared at compaction: you edited ${documents} here (${input.command}); it has changed since. Read it before relying on this edit.]`,
          }
        : {}),
    };
  },
};

/** A search's passages from changed files are cleared; its history form keeps files and counts. */
export const searchDocumentText: DocumentTextPolicy = {
  kind: "read",
  elide({ input = {}, output, result }, changed, treatment) {
    const typed = isSearchHits(result) ? result : isSearchHits(output) ? output : undefined;
    if (!typed)
      return { output: `[Cleared at compaction: search results; search again for current text]` };
    const hits = typed as unknown as SearchHit[];
    if (treatment === "history") return { output: renderSearchFiles(hits) };
    const uris = new Set(changed.map((ref) => ref.uri));
    return {
      output: renderSearchHits(hits, input, (hit) => changed.length === 0 || uris.has(hit.uri)),
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
      output:
        treatment === "history"
          ? "[thread_history output omitted]"
          : `[Cleared at compaction: thread_history output quoting edits to ${documents.map((ref) => ref.uri ?? ref.documentId).join(", ") || "documents"}. Call thread_history again.]`,
    };
  },
};
