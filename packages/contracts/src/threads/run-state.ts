import type { UserMessageBlock } from "../protocol/user-turn-admission.js";
import type { AiWriteMode } from "../works/index.js";
import type { PendingInboxItem } from "./index.js";

export type RunState = {
  version: string;
  items: PendingInboxItem[];
  sentThrough: number;
  execution: { executionId: string; currentTurnId: string | null } | null;
  mode: AiWriteMode;
  blocked: { reason: "credits_exhausted" } | null;
};

export type HandBackRequest = { requestId: string; ids: string[] };

export type HandBackResult = {
  handedBack: { userTurnId: string; blocks: UserMessageBlock[] }[];
  answered: string[];
  gone: string[];
};

export type HandBackResponse = HandBackResult & { runState: RunState };

export type StopRequest = {
  requestId: string;
  seenThrough: number;
  seenExecutionId: string | null;
  mine: string[];
};

export type StopResponse = HandBackResult & {
  threadId: string;
  cancelledExecutionId: string | null;
  runState: RunState;
};

export type SendNowRequest = {
  seenThrough: number;
  seenExecutionId: string;
  waiting: string[];
};

export type SendNowResponse = {
  threadId: string;
  cancelledExecutionId: string | null;
  runState: RunState;
};
