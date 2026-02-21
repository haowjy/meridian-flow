import type { ReviewChunk } from "./types";

export interface ChunkEditSession {
  proposalId: string;
  chunkId: string;
  originalInsertedText: string;
  draftInsertedText: string;
}

export interface ChunkEditCommit {
  proposalId: string;
  chunkId: string;
  originalInsertedText: string;
  insertedText: string;
  wasEdited: boolean;
}

export function startChunkEditSession(chunk: ReviewChunk): ChunkEditSession {
  return {
    proposalId: chunk.proposalId,
    chunkId: chunk.id,
    originalInsertedText: chunk.insertedText,
    draftInsertedText: chunk.insertedText,
  };
}

export function updateChunkEditSession(
  session: ChunkEditSession,
  draftInsertedText: string,
): ChunkEditSession {
  return {
    ...session,
    draftInsertedText,
  };
}

export function resetChunkEditSession(
  session: ChunkEditSession,
): ChunkEditSession {
  return {
    ...session,
    draftInsertedText: session.originalInsertedText,
  };
}

export function commitChunkEditSession(
  session: ChunkEditSession,
): ChunkEditCommit {
  return {
    proposalId: session.proposalId,
    chunkId: session.chunkId,
    originalInsertedText: session.originalInsertedText,
    insertedText: session.draftInsertedText,
    wasEdited: session.draftInsertedText !== session.originalInsertedText,
  };
}

export function cancelChunkEditSession(): null {
  return null;
}
