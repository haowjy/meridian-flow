/** Tool-owned document-text substitutions; the compaction planner decides staleness. */
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

export type DocumentRef = Pick<DocumentRevisionEvidence, "documentId" | "uri">;
export interface DocumentTextPolicy {
  kind(input: JsonObject): "read" | "write" | "none";
  elide(
    block: { input?: JsonObject; output?: JsonValue },
    changed: readonly DocumentRef[],
    treatment: "stale" | "history",
  ): { input?: JsonObject; output?: JsonValue };
}

export function staleReadStub(documents: string): string {
  return `[Cleared at compaction: ${documents} has changed since this read. Read it again before relying on its text.]`;
}

export const writeDocumentText: DocumentTextPolicy = {
  kind(input) {
    switch (input.command) {
      case "read":
      case "diff":
        return "read";
      case "create":
      case "insert":
      case "replace":
      case "delete":
      case "undo":
      case "redo":
        return "write";
      default:
        return "none";
    }
  },
  elide({ input = {}, output }, changed, treatment) {
    const documents =
      changed.map((ref) => ref.uri ?? ref.documentId).join(", ") ||
      String(input.path ?? input.document_id ?? "This document");
    if (treatment === "history") {
      if (input.command === "diff")
        return {
          output: changed.some((ref) => ref.uri)
            ? historyReadStub(documents)
            : "[change summary omitted]",
        };
      if (input.command === "read") return { output: historyReadStub(documents) };
      return { output: `[edit applied to ${documents} (${input.command})]` };
    }
    if (input.command === "diff")
      return {
        output:
          "[Cleared at compaction: this change trail may be out of date. Query diff again before relying on it.]",
      };
    if (input.command === "read") return { output: staleReadStub(documents) };
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
  kind: () => "read",
  elide({ output }, changed, treatment) {
    const uris = new Set(changed.map((ref) => ref.uri));
    return {
      output: (output as JsonObject[]).map((hit) => {
        if (treatment === "stale" && changed.length > 0 && !uris.has(hit.uri as string)) return hit;
        return {
          ...hit,
          matches: (hit.matches as JsonObject[]).map((match) => ({
            ...match,
            excerpt:
              treatment === "history"
                ? historyReadStub(String(hit.uri))
                : "[Cleared at compaction: changed since this search; read it for current text]",
          })),
        };
      }),
    };
  },
};

export function historyReadStub(documents: string): string {
  return `[document copy omitted: ${documents}. Read it for its current text.]`;
}

export const historyDocumentText: DocumentTextPolicy = {
  kind: () => "read",
  elide(_block, documents, treatment) {
    return {
      output:
        treatment === "history"
          ? "[thread_history output omitted]"
          : `[Cleared at compaction: thread_history output quoting edits to ${documents.map((ref) => ref.uri ?? ref.documentId).join(", ") || "documents"}. Call thread_history again.]`,
    };
  },
};
