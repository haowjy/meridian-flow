/** Checkpoints loaded live Yjs documents and drains accepted persistence work. */
import type * as Y from "yjs";

export async function drainYjsPersistence(input: {
  documents: Iterable<[string, Y.Doc]>;
  parseLiveDocument(roomName: string): string | undefined;
  checkpoint(documentId: string, document: Y.Doc): Promise<void>;
  drainPendingWrites(): Promise<void>;
  onCheckpointError?(documentId: string, error: unknown): void;
}): Promise<void> {
  const errors: unknown[] = [];

  for (const [roomName, document] of input.documents) {
    const documentId = input.parseLiveDocument(roomName);
    if (!documentId) continue;
    try {
      await input.checkpoint(documentId, document);
    } catch (error) {
      errors.push(error);
      input.onCheckpointError?.(documentId, error);
    }
  }

  try {
    await input.drainPendingWrites();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more Yjs persistence shutdown operations failed.");
  }
}
