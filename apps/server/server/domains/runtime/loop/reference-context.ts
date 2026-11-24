import {
  type AgentEditResultV1,
  type FrontierLookup,
  isAgentEditResultEnvelope,
  type ObservationFrontier,
  type ReadToolInput,
  renderAgentEditResult,
} from "@meridian/agent-edit/integration";
import type { ProjectId } from "@meridian/contracts";
import type { ReadReferenceOccurrence } from "@meridian/contracts/protocol";
import { type ReferenceOccurrence, referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue } from "@meridian/contracts/threads";
import type { ModelInfo } from "@meridian-flow/runtime/gateway";
import { evidenceFrontiers, type ShownLinkShowing } from "../../../shared/model-evidence.js";
import type { DocumentEvidence } from "../ports/document-evidence.js";
import {
  type DocumentTextTreatment,
  historyReadStub,
  reshownReadStub,
  staleReadStub,
} from "../tools/document-text.js";
import type { ResultEvidence } from "../tools/types.js";

type ReferenceRead = { result: JsonValue; revision: string | null };

export interface ReferenceReader {
  read(
    reference: Extract<ReferenceOccurrence, { kind: "document" }>,
    context: {
      threadId: string;
      turnId: string;
      signal?: AbortSignal;
      input?: ReadToolInput;
      recordingFrontier?: FrontierLookup;
      model?: () => Promise<ModelInfo | undefined>;
    },
  ): Promise<ReferenceRead & { evidence?: ResultEvidence }>;
}

export interface ReferenceEvidence {
  shown: ShownLinkShowing[];
  frontiers: {
    sourceBlockId: string;
    frontier?: ObservationFrontier;
    names?: ObservationFrontier;
  }[];
}

export async function recordReferenceEvidence(
  deps: { documentEvidence: Pick<DocumentEvidence, "resultStored"> },
  owner: { projectId: ProjectId; threadId: string; turnId: string },
  evidence: ReferenceEvidence,
): Promise<void> {
  await deps.documentEvidence.resultStored({
    ...owner,
    shown: evidence.shown,
    frontiers: evidence.frontiers.flatMap(({ sourceBlockId, ...rest }) =>
      evidenceFrontiers(sourceBlockId, rest),
    ),
  });
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
  model?: () => Promise<ModelInfo | undefined>;
}): Promise<LoadedReferenceReads> {
  const images = new Set(
    input.blocks
      .filter((block) => block.turnId === input.userTurnId && block.blockType === "media")
      .flatMap((block) => {
        const content = block.content as { ref?: { documentId?: unknown } } | null;
        return typeof content?.ref?.documentId === "string" ? [content.ref.documentId] : [];
      }),
  );
  const reads = new Map<
    string,
    ReferenceRead & { frontier?: ObservationFrontier; names?: ObservationFrontier }
  >();
  const updated: Block[] = [];
  const evidence: ReferenceEvidence = { shown: [], frontiers: [] };
  for (const block of input.blocks) {
    if (block.turnId !== input.userTurnId) continue;
    const reference = referenceOccurrenceContent(block);
    if (reference?.kind !== "document" || reference.read || images.has(reference.documentId))
      continue;
    input.signal?.throwIfAborted();
    const key = `${reference.documentId}\0${reference.uri}`;
    let result = reads.get(key);
    if (result === undefined) {
      const read = await input.reader.read(reference, {
        threadId: input.threadId,
        turnId: input.assistantTurnId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.recordingFrontier ? { recordingFrontier: input.recordingFrontier } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      result = {
        result: read.result,
        revision: read.revision,
        ...(read.evidence?.frontier ? { frontier: read.evidence.frontier } : {}),
        ...(read.evidence?.names ? { names: read.evidence.names } : {}),
      };
      reads.set(key, result);
      evidence.shown.push(...(read.evidence?.shown ?? []));
    }
    input.signal?.throwIfAborted();
    if (result.frontier || result.names)
      evidence.frontiers.push({
        sourceBlockId: block.id,
        ...(result.frontier ? { frontier: result.frontier } : {}),
        ...(result.names ? { names: result.names } : {}),
      });
    updated.push({
      ...block,
      content: { ...reference, read: { result: result.result, revision: result.revision } },
    });
  }
  return { blocks: updated, evidence };
}

export function referenceReadText(result: JsonValue): string {
  if (typeof result === "string") return result;
  return isAgentEditResultEnvelope(result)
    ? renderAgentEditResult(result as AgentEditResultV1)
    : JSON.stringify(result);
}

export function elideReferenceRead(
  reference: Extract<ReadReferenceOccurrence, { kind: "document" }>,
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
