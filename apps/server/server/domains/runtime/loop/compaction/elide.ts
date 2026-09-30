/** Plans immutable model-only document replacements at a compaction boundary. */
import {
  type DocumentRevisionEvidence,
  referenceOccurrenceContent,
} from "@meridian/contracts/protocol";
import type { Block, JsonObject } from "@meridian/contracts/threads";
import type { CompactionMetadata } from "../../../threads/index.js";
import type { DocumentTextPolicy } from "../../tools/document-text.js";
import { elideReferenceRead } from "../reference-context.js";
import type { RetainedTurnSlice } from "./tail.js";

export type DocumentTextPolicies = (toolName: string) => DocumentTextPolicy | undefined;
export type RecordedDocuments = ReadonlyMap<
  string,
  readonly DocumentRevisionEvidence[] | undefined
>;
export type ModelElisions = NonNullable<CompactionMetadata["elisions"]>;

function documentPairs(blocks: readonly Block[], policies: DocumentTextPolicies) {
  const calls = new Map(
    blocks
      .filter((block) => block.blockType === "tool_use")
      .map((block) => [(block.content as JsonObject).toolCallId, block]),
  );
  return blocks.flatMap((result) => {
    if (result.blockType !== "tool_result") return [];
    const content = result.content as JsonObject;
    if (content.isError) return [];
    const call = calls.get(content.toolCallId);
    if (!call) return [];
    const tool = call.content as JsonObject;
    const policy = policies(tool.toolName as string);
    const input = (tool.input ?? {}) as JsonObject;
    const kind = policy?.kind(input);
    return policy && kind && kind !== "none" ? [{ call, result, input, policy, kind }] : [];
  });
}

/** Raw evidence, not an earlier compaction's substitutions, is the source of each pass. */
export function collectRecordedDocuments(
  slices: readonly RetainedTurnSlice[],
  policies: DocumentTextPolicies,
): RecordedDocuments {
  const recorded = new Map<string, readonly DocumentRevisionEvidence[] | undefined>();
  for (const { blocks } of slices) {
    for (const { result } of documentPairs(blocks, policies)) {
      const metadata = (result.content as JsonObject).metadata as JsonObject | undefined;
      recorded.set(
        result.id,
        metadata?.documentRevisions as DocumentRevisionEvidence[] | undefined,
      );
    }
    for (const block of blocks) {
      const reference = referenceOccurrenceContent(block);
      if (reference?.read)
        recorded.set(block.id, [
          {
            documentId: reference.documentId,
            uri: reference.uri,
            revision: reference.read.revision,
          },
        ]);
    }
  }
  return recorded;
}

export function changedDocuments(
  recorded: RecordedDocuments,
  current: ReadonlyMap<string, string | null>,
): DocumentRevisionEvidence[] {
  return [...recorded.values()].flatMap(
    (refs) =>
      refs?.filter(
        (ref) =>
          ref.revision === null ||
          !current.get(ref.documentId) ||
          current.get(ref.documentId) !== ref.revision,
      ) ?? [],
  );
}

export function planModelElisions(input: {
  retainedSuffix: readonly RetainedTurnSlice[];
  recorded: RecordedDocuments;
  current: ReadonlyMap<string, string | null>;
  policies: DocumentTextPolicies;
}): ModelElisions {
  const { retainedSuffix, recorded, current, policies } = input;
  const elisions: ModelElisions = [];
  for (const { blocks } of retainedSuffix) {
    for (const { call, result, input: toolInput, policy, kind } of documentPairs(
      blocks,
      policies,
    )) {
      const refs = recorded.get(result.id);
      const changed = changedDocuments(new Map([[result.id, refs]]), current);
      const diff =
        (call.content as JsonObject).toolName === "write" && toolInput.command === "diff";
      if (!diff && refs !== undefined && changed.length === 0) continue;
      const uris = [...new Set(changed.flatMap((ref) => (ref.uri ? [ref.uri] : [])))];
      const replacement = policy.elide(
        { input: toolInput, output: (result.content as JsonObject).output },
        changed,
        "stale",
      );
      const treatment = kind === "write" ? "stale_write" : "stale_read";
      if (replacement.input !== undefined)
        elisions.push({
          blockId: call.id,
          treatment,
          uris,
          content: { ...(call.content as JsonObject), input: replacement.input },
        });
      if (replacement.output !== undefined)
        elisions.push({
          blockId: result.id,
          treatment,
          uris,
          content: { ...(result.content as JsonObject), output: replacement.output },
        });
    }
    for (const block of blocks) {
      const reference = referenceOccurrenceContent(block);
      if (!reference?.read) continue;
      const refs = recorded.get(block.id);
      if (refs !== undefined && changedDocuments(new Map([[block.id, refs]]), current).length === 0)
        continue;
      elisions.push({
        blockId: block.id,
        treatment: "stale_read",
        uris: [reference.uri],
        content: elideReferenceRead(reference, "stale"),
      });
    }
  }
  // No caller-owned object survives inside the write-once metadata.
  return structuredClone(elisions);
}
