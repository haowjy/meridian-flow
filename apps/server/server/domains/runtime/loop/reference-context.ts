/**
 * Loads explicit references for a turn the run will send; history replays
 * saved results. Shown-link candidates travel beside the updated blocks,
 * never inside their content, until the commit that persists those blocks.
 */

import type { ReadReferenceOccurrence } from "@meridian/contracts/protocol";
import { type ReferenceOccurrence, referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue } from "@meridian/contracts/threads";
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
    },
  ): Promise<ReferenceRead & { shown?: readonly ShownLinkShowing[] }>;
}

export interface LoadedReferenceReads {
  blocks: Block[];
  /** Host-only: what the reads showed, for the commit that persists `blocks`. */
  shown: ShownLinkShowing[];
}

export async function loadReferenceReads(input: {
  blocks: readonly Block[];
  userTurnId: string;
  threadId: string;
  assistantTurnId: string;
  reader: ReferenceReader;
  signal?: AbortSignal;
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
  const reads = new Map<string, ReferenceRead>();
  const updated: Block[] = [];
  const shown: ShownLinkShowing[] = [];
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
      });
      result = { result: read.result, revision: read.revision };
      reads.set(key, result);
      shown.push(...(read.shown ?? []));
    }
    input.signal?.throwIfAborted();
    updated.push({ ...block, content: { ...reference, read: result } });
  }
  return { blocks: updated, shown };
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
