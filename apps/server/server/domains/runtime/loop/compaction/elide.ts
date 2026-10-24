/** Plans immutable model-only document replacements at a compaction boundary. */
import {
  type DocumentRevisionEvidence,
  referenceOccurrenceContent,
} from "@meridian/contracts/protocol";
import { type Block, isNotesStepHeldResult, type JsonObject } from "@meridian/contracts/threads";
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
    if (content.isError || isNotesStepHeldResult(content.result)) return [];
    const call = calls.get(content.toolCallId);
    if (!call) return [];
    const tool = call.content as JsonObject;
    const policy = policies(tool.toolName as string);
    const input = (tool.input ?? {}) as JsonObject;
    return policy ? [{ call, result, input, policy, kind: policy.kind }] : [];
  });
}

/** Raw evidence, not an earlier compaction's substitutions, is the source of each pass. */
export function collectRecordedDocuments(
  slices: readonly RetainedTurnSlice[],
  policies: DocumentTextPolicies,
): RecordedDocuments {
  const recorded = new Map<string, readonly DocumentRevisionEvidence[] | undefined>();
  for (const { turn, blocks } of slices) {
    for (const { result } of documentPairs(blocks, policies)) {
      const metadata = (result.content as JsonObject).metadata as JsonObject | undefined;
      recorded.set(
        result.id,
        metadata?.documentRevisions as DocumentRevisionEvidence[] | undefined,
      );
    }
    // The recent picker reverses Map insertion order. Compaction blocks are persisted
    // most important first, so insert their evidence backwards to favour that first block.
    const referenceBlocks = turn.role === "compaction" ? [...blocks].reverse() : blocks;
    for (const block of referenceBlocks) {
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

function staleRefs(
  refs: readonly DocumentRevisionEvidence[],
  current: ReadonlyMap<string, string | null>,
): DocumentRevisionEvidence[] {
  return refs.filter(
    (ref) =>
      ref.revision === null ||
      !current.get(ref.documentId) ||
      current.get(ref.documentId) !== ref.revision,
  );
}

export function changedDocuments(
  recorded: RecordedDocuments,
  current: ReadonlyMap<string, string | null>,
): DocumentRevisionEvidence[] {
  return [...recorded.values()].flatMap((refs) => (refs ? staleRefs(refs, current) : []));
}

/**
 * Why one block's document text is replaced, or null when it stays. Missing
 * evidence fails closed as stale. A copy of a document the compaction re-shows
 * is a duplicate (`reshown`) unless some other document in it also went stale.
 */
function elisionOf(
  refs: readonly DocumentRevisionEvidence[] | undefined,
  current: ReadonlyMap<string, string | null>,
  reshown: ReadonlySet<string>,
): { targets: DocumentRevisionEvidence[]; treatment: "stale" | "reshown" } | null {
  if (refs === undefined) return { targets: [], treatment: "stale" };
  const changed = staleRefs(refs, current);
  const targets = refs.filter((ref) => changed.includes(ref) || reshown.has(ref.documentId));
  if (targets.length === 0) return null;
  const stale = changed.some((ref) => !reshown.has(ref.documentId));
  return { targets, treatment: stale ? "stale" : "reshown" };
}

export function planModelElisions(input: {
  retainedSuffix: readonly RetainedTurnSlice[];
  recorded: RecordedDocuments;
  current: ReadonlyMap<string, string | null>;
  /** Documents the compaction re-shows in full after its summary. */
  reshown?: ReadonlySet<string>;
  policies: DocumentTextPolicies;
}): ModelElisions {
  const { retainedSuffix, recorded, current, policies } = input;
  const reshown = input.reshown ?? new Set<string>();
  const elisions: ModelElisions = [];
  for (const { blocks } of retainedSuffix) {
    for (const { call, result, input: toolInput, policy, kind } of documentPairs(
      blocks,
      policies,
    )) {
      const elision = elisionOf(recorded.get(result.id), current, reshown);
      if (!elision) continue;
      const { targets, treatment: why } = elision;
      const uris = [...new Set(targets.flatMap((ref) => (ref.uri ? [ref.uri] : [])))];
      const replacement = policy.elide(
        {
          input: toolInput,
          output: (result.content as JsonObject).output,
          result: (result.content as JsonObject).result,
        },
        targets,
        why,
      );
      const treatment =
        why === "reshown" ? "reshown" : kind === "write" ? "stale_write" : "stale_read";
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
      const elision = elisionOf(recorded.get(block.id), current, reshown);
      if (!elision) continue;
      elisions.push({
        blockId: block.id,
        treatment: elision.treatment === "reshown" ? "reshown" : "stale_read",
        uris: [reference.uri],
        content: elideReferenceRead(reference, elision.treatment),
      });
    }
  }
  // No caller-owned object survives inside the write-once metadata.
  return structuredClone(elisions);
}
