/**
 * Loads explicit references for a turn the run will send; history replays
 * saved results. What the reads showed (shown-link candidates and observation
 * frontiers) travels beside the updated blocks, never inside their content,
 * until the commit that persists those blocks.
 */

import type { ReadReferenceOccurrence } from "@meridian/contracts/protocol";
import { type ReferenceOccurrence, referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue } from "@meridian/contracts/threads";
import type { FrontierLookups, RoomFrontier } from "../ports/observation-frontiers.js";
import type { ShownLinkShowing } from "../ports/shown-links.js";
import { historyReadStub, staleReadStub } from "../tools/document-text.js";

type ReferenceRead = { result: JsonValue; revision: string | null };

export interface ReferenceReader {
  read(
    reference: ReferenceOccurrence,
    context: {
      threadId: string;
      turnId: string;
      signal?: AbortSignal;
      /** The read records its frontier, chained from this lookup. */
      recordingFrontier?: FrontierLookups["recording"];
    },
  ): Promise<
    ReferenceRead & { shown?: readonly ShownLinkShowing[]; frontiers?: readonly RoomFrontier[] }
  >;
}

/**
 * Host-only: what reference reads showed the model, recorded only by the
 * commit that persists their blocks; a discarded or retried preparation records nothing.
 */
export interface ReferenceEvidence {
  shown: ShownLinkShowing[];
  /** Each reference block's frontiers: the block whose materialized read the model is sent. */
  frontiers: { sourceBlockId: string; frontiers: readonly RoomFrontier[] }[];
}

export const NO_REFERENCE_EVIDENCE: ReferenceEvidence = { shown: [], frontiers: [] };

export function mergeReferenceEvidence(
  ...all: readonly (ReferenceEvidence | undefined)[]
): ReferenceEvidence {
  return {
    shown: all.flatMap((evidence) => evidence?.shown ?? []),
    frontiers: all.flatMap((evidence) => evidence?.frontiers ?? []),
  };
}

export function hasReferenceEvidence(evidence: ReferenceEvidence | undefined): boolean {
  return !!evidence && (evidence.shown.length > 0 || evidence.frontiers.length > 0);
}

export interface LoadedReferenceReads {
  blocks: Block[];
  evidence: ReferenceEvidence;
}

export async function loadReferenceReads(input: {
  blocks: readonly Block[];
  userTurnId: string;
  threadId: string;
  assistantTurnId: string;
  reader: ReferenceReader;
  signal?: AbortSignal;
  recordingFrontier?: FrontierLookups["recording"];
}): Promise<LoadedReferenceReads> {
  const images = new Set(
    input.blocks
      .filter((block) => block.turnId === input.userTurnId && block.blockType === "image")
      .flatMap((block) => {
        const content = block.content;
        return content &&
          typeof content === "object" &&
          !Array.isArray(content) &&
          typeof content.documentId === "string"
          ? [content.documentId]
          : [];
      }),
  );
  const reads = new Map<string, ReferenceRead & { frontiers: readonly RoomFrontier[] }>();
  const updated: Block[] = [];
  const evidence: ReferenceEvidence = { shown: [], frontiers: [] };
  for (const block of input.blocks) {
    if (block.turnId !== input.userTurnId) continue;
    const reference = referenceOccurrenceContent(block);
    if (!reference || reference.read || images.has(reference.documentId)) continue;
    input.signal?.throwIfAborted();
    const key = `${reference.documentId}\0${reference.uri}`;
    let result = reads.get(key);
    if (result === undefined) {
      const read = await input.reader.read(reference, {
        threadId: input.threadId,
        turnId: input.assistantTurnId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.recordingFrontier ? { recordingFrontier: input.recordingFrontier } : {}),
      });
      result = { result: read.result, revision: read.revision, frontiers: read.frontiers ?? [] };
      reads.set(key, result);
      evidence.shown.push(...(read.shown ?? []));
    }
    input.signal?.throwIfAborted();
    // A repeated mention shows the same read, so its block records the same frontier.
    if (result.frontiers.length > 0)
      evidence.frontiers.push({ sourceBlockId: block.id, frontiers: result.frontiers });
    updated.push({
      ...block,
      content: { ...reference, read: { result: result.result, revision: result.revision } },
    });
  }
  return { blocks: updated, evidence };
}

/** Only the materialized document read changes; writer wording and the mention remain intact. */
export function elideReferenceRead(
  reference: ReadReferenceOccurrence,
  treatment: "stale" | "history",
): JsonValue {
  return {
    ...reference,
    read: {
      ...reference.read,
      result:
        treatment === "history" ? historyReadStub(reference.uri) : staleReadStub(reference.uri),
    },
  };
}
