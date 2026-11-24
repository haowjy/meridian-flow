export type EventLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type EventSensitivity = "safe" | "protected_reference";

export interface EventCorrelation {
  traceId?: string;
  runId?: string;
  parentRunId?: string;
  requestId?: string;
  threadId?: string;
  turnId?: string;
  childRunId?: string;
  agentSlug?: string;
  iteration?: number;
  attemptId?: string;
  gatewayCallId?: string;
  provider?: string;
  model?: string;
  route?: string;
  method?: string;
  projectId?: string;
  workId?: string;
  toolName?: string;
  toolCallId?: string;
  errorCode?: string;
  documentId?: string;
  draftId?: string;
  folderIds?: string;
  batchId?: string;
}

export interface TraceStreamRef {
  streamId: string;
  transport: "thread" | "loro" | "gateway";
  direction?: "client_to_server" | "server_to_client";
  observedAt: "client" | "server";
  messageClass?: string;
  bytes?: number;
  observerSeq: number;
}

export interface EventRecord {
  eventId?: string;
  timestamp: string;
  level: EventLevel;
  source: string;
  name: string;
  sensitivity?: EventSensitivity;
  correlation?: EventCorrelation;
  stream?: TraceStreamRef;
  payload: Record<string, unknown>;
}
