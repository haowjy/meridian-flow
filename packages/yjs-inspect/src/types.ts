/** Metadata-only descriptions of Hocuspocus and Y-protocol messages. */

export type YjsMessageClass =
  | "sync.step1"
  | "sync.step2"
  | "sync.update"
  | "awareness"
  | "stateless"
  | "auth"
  | "sync.status"
  | "close"
  | "ping"
  | "pong";

export type InnerSyncType = "step1" | "step2" | "update";

interface KnownFrameSummaryBase {
  documentName: string;
  payloadBytes: number;
}

export interface SyncStep1FrameSummary extends KnownFrameSummaryBase {
  messageClass: "sync.step1";
  innerSyncType: "step1";
  applied?: never;
}

export interface SyncStep2FrameSummary extends KnownFrameSummaryBase {
  messageClass: "sync.step2";
  innerSyncType: "step2";
  applied?: never;
}

export interface SyncUpdateFrameSummary extends KnownFrameSummaryBase {
  messageClass: "sync.update";
  innerSyncType: "update";
  applied?: never;
}

export type SyncFrameSummary =
  | SyncStep1FrameSummary
  | SyncStep2FrameSummary
  | SyncUpdateFrameSummary;

export interface AwarenessFrameSummary extends KnownFrameSummaryBase {
  messageClass: "awareness";
  innerSyncType?: never;
  applied?: never;
}

export interface StatelessFrameSummary extends KnownFrameSummaryBase {
  messageClass: "stateless";
  innerSyncType?: never;
  applied?: never;
}

export interface AuthFrameSummary extends KnownFrameSummaryBase {
  messageClass: "auth";
  innerSyncType?: never;
  applied?: never;
}

export interface SyncStatusFrameSummary extends KnownFrameSummaryBase {
  messageClass: "sync.status";
  applied: boolean;
  innerSyncType?: never;
}

export interface CloseFrameSummary extends KnownFrameSummaryBase {
  messageClass: "close";
  innerSyncType?: never;
  applied?: never;
}

interface ConnectionControlFrameSummaryBase {
  documentName: null;
  payloadBytes: number;
  innerSyncType?: never;
  applied?: never;
}

export interface PingFrameSummary extends ConnectionControlFrameSummaryBase {
  messageClass: "ping";
}

export interface PongFrameSummary extends ConnectionControlFrameSummaryBase {
  messageClass: "pong";
}

export type NonSyncFrameSummary =
  | AwarenessFrameSummary
  | StatelessFrameSummary
  | AuthFrameSummary
  | SyncStatusFrameSummary
  | CloseFrameSummary
  | PingFrameSummary
  | PongFrameSummary;

export type KnownFrameSummary = SyncFrameSummary | NonSyncFrameSummary;

export interface UnknownFrameSummary {
  documentName: string | null;
  messageClass: "unknown";
  payloadBytes: number;
  innerSyncType?: never;
  applied?: never;
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

export interface InvalidUpdate {
  invalid: true;
  reason: string;
  bytes: number;
  updateHash: string;
}

export interface UpdateFrameInspection {
  frame: SyncStep2FrameSummary | SyncUpdateFrameSummary;
  update?: UpdateSummary;
  awareness?: never;
}

export interface AwarenessFrameInspection {
  frame: AwarenessFrameSummary;
  awareness?: AwarenessSummary;
  update?: never;
}

export interface OtherFrameInspection {
  frame:
    | SyncStep1FrameSummary
    | StatelessFrameSummary
    | AuthFrameSummary
    | SyncStatusFrameSummary
    | CloseFrameSummary
    | PingFrameSummary
    | PongFrameSummary
    | UnknownFrameSummary;
  update?: never;
  awareness?: never;
}

export type FrameInspection =
  | UpdateFrameInspection
  | AwarenessFrameInspection
  | OtherFrameInspection;

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
