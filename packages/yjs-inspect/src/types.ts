/** Metadata-only descriptions of Hocuspocus and Y-protocol messages. */

export type YjsMessageClass =
  | "sync.step1"
  | "sync.step2"
  | "sync.update"
  | "awareness"
  | "stateless"
  | "auth";

export type InnerSyncType = "step1" | "step2" | "update";

export interface KnownFrameSummary {
  documentName: string;
  messageClass: YjsMessageClass;
  innerSyncType?: InnerSyncType;
  payloadBytes: number;
}

export interface UnknownFrameSummary {
  documentName: string | null;
  messageClass: "unknown";
  payloadBytes: number;
}

export type FrameSummary = KnownFrameSummary | UnknownFrameSummary;

export interface UpdateClientRange {
  client: number;
  clockFrom: number;
  clockTo: number;
}

export interface UpdateSummary {
  clients: UpdateClientRange[];
  structCount: number;
  deleteSetSize: number;
  isNoop: boolean;
  bytes: number;
  updateHash: string;
}

export interface AwarenessClientDelta {
  client: number;
  clock: number;
  removed: boolean;
}

export interface AwarenessSummary {
  clients: AwarenessClientDelta[];
  count: number;
  removedCount: number;
  bytes: number;
}
