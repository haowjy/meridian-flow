export interface HeadRow {
  documentId: string;
  fragmentName: string;
  schemaVersion: number;
  filetype: string;
  latestUpdateSeq: number;
  latestStateVector: Uint8Array | null;
  latestCheckpointId: number | null;
}

export interface UpdateRow {
  seq: number;
  documentId: string;
  updateData: Uint8Array;
  originType: string | null;
  actorUserId: string | null;
  actorAgentRunId: string | null;
  actorTurnId: string | null;
  createdAt: string;
}

export interface CheckpointRow {
  id: number;
  documentId: string;
  state: Uint8Array;
  stateVector: Uint8Array;
  upToSeq: number;
  reason: string | null;
  createdAt: string;
}

export interface RestorePointRow {
  id: string;
  documentId: string;
  name: string;
  checkpointId: number | null;
  upToSeq: number | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface AppendUpdateInput {
  documentId: string;
  updateData: Uint8Array;
  originType: string | null;
  actorUserId: string | null;
  actorAgentRunId: string | null;
  actorTurnId: string | null;
}

export interface InsertCheckpointInput {
  documentId: string;
  state: Uint8Array;
  stateVector: Uint8Array;
  upToSeq: number;
  reason: string | null;
}

export interface InsertRestorePointInput {
  documentId: string;
  name: string;
  checkpointId: number | null;
  upToSeq: number | null;
  createdByUserId: string | null;
}

export interface DocumentStore {
  transaction<T>(fn: (store: DocumentStore) => Promise<T>): Promise<T>;
  getHead(documentId: string): Promise<HeadRow | null>;
  upsertHead(head: HeadRow): Promise<void>;
  /** Updates only latestCheckpointId — avoids clobbering concurrent head advances. */
  setLatestCheckpointId(documentId: string, checkpointId: number): Promise<void>;
  appendUpdate(input: AppendUpdateInput): Promise<number>;
  listUpdatesAfter(documentId: string, afterSeq: number): Promise<UpdateRow[]>;
  insertCheckpoint(input: InsertCheckpointInput): Promise<number>;
  getLatestCheckpoint(documentId: string): Promise<CheckpointRow | null>;
  getCheckpoint(checkpointId: number): Promise<CheckpointRow | null>;
  listCheckpoints(documentId: string): Promise<CheckpointRow[]>;
  insertRestorePoint(input: InsertRestorePointInput): Promise<RestorePointRow>;
  listRestorePoints(documentId: string): Promise<RestorePointRow[]>;
  getRestorePoint(id: string): Promise<RestorePointRow | null>;
}
