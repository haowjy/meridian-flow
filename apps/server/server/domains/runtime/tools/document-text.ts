/** Tool-owned document-text substitutions; the compaction planner decides staleness. */
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

export type DocumentRef = Pick<DocumentRevisionEvidence, "documentId" | "uri">;
export interface DocumentTextPolicy {
  kind(input: JsonObject): "read" | "write" | "none";
  elide(
    block: { input?: JsonObject; output?: JsonValue },
    changed: readonly DocumentRef[],
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
  elide({ input = {}, output }, changed) {
    const documents =
      changed.map((ref) => ref.uri ?? ref.documentId).join(", ") ||
      String(input.path ?? input.document_id ?? "This document");
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
  elide({ output }, changed) {
    const uris = new Set(changed.map((ref) => ref.uri));
    return {
      output: (output as JsonObject[]).map((hit) => {
        if (changed.length > 0 && !uris.has(hit.uri as string)) return hit;
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
