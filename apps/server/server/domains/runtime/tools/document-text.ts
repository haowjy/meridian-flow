/** Tool-owned document-text substitutions; the compaction planner decides staleness. */
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

export type DocumentRef = Pick<DocumentRevisionEvidence, "documentId" | "uri">;
export interface DocumentTextPolicy {
  /** Whether the tool's results hold document text it read or text it wrote. */
  kind: "read" | "write";
  elide(
    block: { input?: JsonObject; output?: JsonValue },
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

export const searchDocumentText: DocumentTextPolicy = {
  kind: "read",
  elide({ output }, changed, treatment) {
    const uris = new Set(changed.map((ref) => ref.uri));
    return {
      output: (output as JsonObject[]).map((hit) => {
        if (treatment === "stale" && changed.length > 0 && !uris.has(hit.uri as string)) return hit;
        if (treatment === "history")
          return {
            uri: hit.uri,
            matchCount: hit.matchCount,
            omitted: "read it for current text",
          };
        return {
          ...hit,
          matches: (hit.matches as JsonObject[]).map((match) => ({
            ...match,
            excerpt: "[Cleared at compaction: changed since this search; read it for current text]",
          })),
        };
      }),
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
