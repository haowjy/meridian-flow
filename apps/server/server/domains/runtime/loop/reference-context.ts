/**
 * Loads explicit references for a turn the run will send; history replays
 * saved results. What the reads showed (shown-link candidates and observation
 * frontiers) travels beside the updated blocks, never inside their content,
 * until the commit that persists those blocks.
 */

import {
  type AgentEditResultV1,
  type FrontierLookup,
  isAgentEditResultEnvelope,
  type ObservationFrontier,
  type ReadToolInput,
  renderAgentEditResult,
} from "@meridian/agent-edit/integration";
import type { ReadReferenceOccurrence } from "@meridian/contracts/protocol";
import { type ReferenceOccurrence, referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue } from "@meridian/contracts/threads";
import type { ShownLinkShowing, ShownLinkStore } from "../ports/shown-links.js";
import {
  type DocumentTextTreatment,
  historyReadStub,
  reshownReadStub,
  staleReadStub,
} from "../tools/document-text.js";
import type { ResultEvidence } from "../tools/types.js";
import { type FrontierRecordingDeps, recordFrontier } from "./frontier-recording.js";

type ReferenceRead = { result: JsonValue; revision: string | null };

export interface ReferenceReader {
  read(
    reference: ReferenceOccurrence,
    context: {
      threadId: string;
      turnId: string;
      signal?: AbortSignal;
      input?: ReadToolInput;
      /** The read records its frontier, chained from this lookup. */
      recordingFrontier?: FrontierLookup;
    },
  ): Promise<ReferenceRead & { evidence?: ResultEvidence }>;
}

/**
 * Host-only: what reference reads showed the model, recorded only by the
 * commit that persists their blocks; a discarded or retried preparation records nothing.
 */
export interface ReferenceEvidence {
  shown: ShownLinkShowing[];
  /** Each reference block's frontier: the block whose materialized read the model is sent. */
  frontiers: { sourceBlockId: string; frontier: ObservationFrontier }[];
}

/**
 * Records accepted reference reads' evidence: shown links under the turn whose
 * request shows them, frontiers on each reference block. Callers run it inside
 * the commit persisting those blocks, after they are projected.
 */
export async function recordReferenceEvidence(
  deps: FrontierRecordingDeps & { shownLinks: Pick<ShownLinkStore, "record"> },
  threadId: string,
  turnId: string,
  evidence: ReferenceEvidence,
): Promise<void> {
  for (const showing of evidence.shown)
    await deps.shownLinks.record({ ...showing, threadId, turnId });
  for (const { sourceBlockId, frontier } of evidence.frontiers)
    await recordFrontier(deps, sourceBlockId, frontier, { threadId, turnId });
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
  recordingFrontier?: FrontierLookup;
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
  const reads = new Map<string, ReferenceRead & { frontier?: ObservationFrontier }>();
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
      result = {
        result: read.result,
        revision: read.revision,
        ...(read.evidence?.frontier ? { frontier: read.evidence.frontier } : {}),
      };
      reads.set(key, result);
      evidence.shown.push(...(read.evidence?.shown ?? []));
    }
    input.signal?.throwIfAborted();
    // A repeated mention shows the same read, so its block records the same frontier.
    if (result.frontier)
      evidence.frontiers.push({ sourceBlockId: block.id, frontier: result.frontier });
    updated.push({
      ...block,
      content: { ...reference, read: { result: result.result, revision: result.revision } },
    });
  }
  return { blocks: updated, evidence };
}

/** A reference read reaches the model as the same text a `read` call returns (D43). */
export function referenceReadText(result: JsonValue): string {
  if (typeof result === "string") return result;
  return isAgentEditResultEnvelope(result)
    ? renderAgentEditResult(result as AgentEditResultV1)
    : JSON.stringify(result);
}

/** Only the materialized document read changes; writer wording and the mention remain intact. */
export function elideReferenceRead(
  reference: ReadReferenceOccurrence,
  treatment: DocumentTextTreatment,
): JsonValue {
  const stub =
    treatment === "history"
      ? historyReadStub
      : treatment === "reshown"
        ? reshownReadStub
        : staleReadStub;
  return { ...reference, read: { ...reference.read, result: stub(reference.uri) } };
}
