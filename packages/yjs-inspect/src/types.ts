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

/** A Yjs clock range, with an inclusive `clockFrom` and exclusive `clockTo`. */
export interface Span {
  client: number;
  clockFrom: number;
  clockTo: number;
}

export interface UpdateSummary {
  structSpans: Span[];
  deleteSpans: Span[];
  /**
   * Struct (`s`) tokens followed by delete (`d`) tokens, each sorted by
   * client then `clockFrom` and joined by commas. A no-op has an empty key.
   */
  spansKey: string;
  structCount: number;
  deleteRangeCount: number;
  deletedLength: number;
  isNoop: boolean;
  bytes: number;
  updateHash: string;
}

export interface FrameInspection {
  frame: FrameSummary;
  update?: UpdateSummary;
  awareness?: AwarenessSummary;
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
