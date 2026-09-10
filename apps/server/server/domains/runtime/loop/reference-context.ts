/** Loads explicit references once before the first model call; history replays saved results. */
import { type ReferenceOccurrence, referenceOccurrenceContent } from "@meridian/contracts/protocol";
import type { Block, JsonValue } from "@meridian/contracts/threads";

export interface ReferenceReader {
  read(
    reference: ReferenceOccurrence,
    context: {
      threadId: string;
      turnId: string;
    },
  ): Promise<JsonValue>;
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
  const reads = new Map<string, JsonValue>();
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
    updated.push({ ...block, content: { ...reference, read: { result } } });
  }
  return updated;
}
