import { documentPathKey, splitDocumentHrefSuffix } from "@meridian/contracts";
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import {
  type GrepToolResult,
  isGrepResult,
  renderGrepFileList,
  renderGrepFiles,
} from "./grep-result.js";

export type DocumentTextTreatment = "stale" | "reshown" | "history";
export type DocumentRef = Pick<DocumentRevisionEvidence, "documentId" | "uri">;
export interface DocumentTextPolicy {
  kind: "read" | "write";
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
  return `[Cleared at compaction: ${documents} has changed since this read.]`;
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

export function showsDocumentText(result: JsonValue | undefined): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  return result.status === "returned" || (result.status === "not_found" && "blocks" in result);
}

export const writeDocumentText: DocumentTextPolicy = {
  kind: "write",
  elide({ input = {}, result }, changed, treatment) {
    const documents = documentsLabel(changed, input);
    if (showsDocumentText(result)) {
      const { content: _content, find: _find, around: _around, ...kept } = input;
      return {
        ...(["create", "insert", "replace"].includes(String(input.command)) ? { input: kept } : {}),
        text: `[edit not applied to ${documents} (${input.command})]`,
      };
    }
    if (treatment === "history") {
      return { text: `[edit applied to ${documents} (${input.command})]` };
    }
    const { content: _content, find: _find, around: _around, ...kept } = input;
    return {
      ...(["create", "insert", "replace"].includes(String(input.command)) ? { input: kept } : {}),
      text:
        treatment === "reshown"
          ? `[Cleared at compaction: you edited ${documents} here (${input.command}); its current text is shown after the summary.]`
          : `[Cleared at compaction: you edited ${documents} here (${input.command}); it has changed since.]`,
    };
  },
};

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
  return `[omitted: ${documents}]`;
}

export const historyDocumentText: DocumentTextPolicy = {
  kind: "read",
  elide(_block, documents, treatment) {
    return {
      text:
        treatment === "history"
          ? "[thread_history output omitted]"
          : `[Cleared at compaction: thread_history output quoting edits to ${documents.map((ref) => ref.uri ?? ref.documentId).join(", ") || "documents"}.]`,
    };
  },
};
