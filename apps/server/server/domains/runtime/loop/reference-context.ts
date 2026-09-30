/** Loads explicit reference reads and projects them without host-only evidence. */

import type { ReadReferenceOccurrence } from "@meridian/contracts/protocol";
import { type ReferenceOccurrence, referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue } from "@meridian/contracts/threads";
import { historyReadStub, staleReadStub } from "../tools/document-text.js";

export interface ReferenceReader {
  read(
    reference: ReferenceOccurrence,
    context: {
      threadId: string;
      turnId: string;
    },
  ): Promise<{ result: JsonValue; revision: string | null }>;
}

export type ModelReferenceOccurrence = ReferenceOccurrence & {
  read?: { result: JsonValue };
};

/** Parses a reference for model context while removing host-only revision evidence. */
export function modelReferenceOccurrenceContent(block: {
  blockType: unknown;
  content: unknown;
}): ModelReferenceOccurrence | null {
  const persisted = referenceOccurrenceContent(block);
  if (persisted)
    return persisted.read ? { ...persisted, read: { result: persisted.read.result } } : persisted;

  const content = block.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const read = (content as Record<string, unknown>).read;
  if (
    !read ||
    typeof read !== "object" ||
    Array.isArray(read) ||
    Object.keys(read).length !== 1 ||
    !("result" in read) ||
    read.result === undefined
  )
    return null;
  const validated = referenceOccurrenceContent({
    blockType: block.blockType,
    content: { ...content, read: { result: read.result, revision: null } },
  });
  return validated ? { ...validated, read: { result: read.result as JsonValue } } : null;
}

export async function loadReferenceReads(input: {
  blocks: readonly Block[];
  userTurnId: string;
  threadId: string;
  assistantTurnId: string;
  reader: ReferenceReader;
  signal?: AbortSignal;
}): Promise<Block[]> {
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
  const reads = new Map<string, { result: JsonValue; revision: string | null }>();
  const updated: Block[] = [];
  for (const block of input.blocks) {
    if (block.turnId !== input.userTurnId) continue;
    const reference = referenceOccurrenceContent(block);
    if (!reference || reference.read || images.has(reference.documentId)) continue;
    input.signal?.throwIfAborted();
    const key = `${reference.documentId}\0${reference.uri}`;
    let result = reads.get(key);
    if (result === undefined) {
      result = await input.reader.read(reference, {
        threadId: input.threadId,
        turnId: input.assistantTurnId,
      });
      reads.set(key, result);
    }
    input.signal?.throwIfAborted();
    updated.push({ ...block, content: { ...reference, read: result } });
  }
  return updated;
}

/** Only the materialized document read changes; writer wording and the mention remain intact. */
export function elideReferenceRead(
  reference: ReadReferenceOccurrence,
  treatment: "stale" | "history",
): JsonValue {
  return {
    ...reference,
    read: {
      result:
        treatment === "history" ? historyReadStub(reference.uri) : staleReadStub(reference.uri),
    },
  };
}
