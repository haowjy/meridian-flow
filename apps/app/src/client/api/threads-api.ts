import {
  type AdmissionLookup,
  API_THREADS_PATH,
  admissionLookupSchema,
  apiAvailableSkillsPath,
  apiThreadAdmissionPath,
  apiThreadCancelPath,
  apiThreadControlsPath,
  apiThreadControlWithdrawPath,
  apiThreadForkPath,
  apiThreadHandoffBriefPath,
  apiThreadHandoffPath,
  apiThreadMessagePath,
  apiThreadModelRequestsDebugPath,
  apiThreadPath,
  apiThreadRestorePath,
  apiThreadSkillsPath,
  apiThreadSnapshotPath,
  apiThreadTitlePath,
  apiThreadTranscriptPath,
  apiThreadTurnContextPreviewDebugPath,
  apiThreadTurnRetryPath,
  apiThreadUserStatePath,
  apiThreadWorkPath,
  type CancelTurnResponse,
  cancelTurnResponseSchema,
  deserializeTransport,
  type ForkThreadRequest,
  type HandoffBriefRetryRequest,
  type HandoffThreadRequest,
  type ListThreadsResponse,
  listThreadsResponseSchema,
  type ModelRequestDebugListResponse,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type ReplyRetryRequest,
  type ReplyRetryResponse,
  type RetireAdmissionResult,
  type SendMessageResponse,
  sendMessageResponseSchema,
  type Thread,
  type ThreadAvailableSkillsResponse,
  type ThreadSnapshotResponse,
  type TranscriptPagePathOptions,
  type TranscriptPageResponse,
  type Turn,
  type TurnContextPreview,
  threadAvailableSkillsResponseSchema,
  threadSnapshotSchema,
  type UpdateThreadUserStateRequest,
  type UpdateThreadUserStateResponse,
} from "@meridian/contracts/protocol";
import type {
  EnqueueThreadControlRequest,
  EnqueueThreadControlResponse,
  WithdrawThreadControlResponse,
} from "@meridian/contracts/threads";
import { threadSchema, turnSchema } from "@meridian/contracts/threads";
import type { RebindThreadWorkRequest, RebindThreadWorkResponse } from "@meridian/contracts/works";

import type { HttpResult } from "@meridian/thread-client";
import {
  deleteJson,
  deleteRequest,
  getJson,
  patchJson,
  postJson,
  putJson,
  readResponsePayload,
} from "./http-client";

export type AppendUserMessageInput = {
  threadId: string;
  submissionId: string;
  text: string;
  blocks: readonly import("@meridian/contracts/protocol").UserMessageBlock[];
  references: readonly import("@meridian/contracts/protocol").SubmittedReference[];
  activatedSkillSlugs?: readonly string[];
};

type CancelTurnInput = {
  threadId: string;
  turnId: string;
  reason?: string;
};

type GetThreadSnapshotInput = {
  threadId: string;
  after?: string;
};

export async function listThreads(init?: {
  origin?: string;
  headers?: HeadersInit;
}): Promise<Thread[]> {
  const url = init?.origin ? new URL(API_THREADS_PATH, init.origin).toString() : API_THREADS_PATH;
  const response = await getJson<ListThreadsResponse>(url, {
    headers: init?.headers,
    schema: listThreadsResponseSchema,
  });
  return response.threads;
}

/** Create-or-get a fork under the client-minted `request.id`; a retry lands on the same thread. */
export function forkThread(sourceThreadId: string, request: ForkThreadRequest): Promise<Thread> {
  return postJson(apiThreadForkPath(sourceThreadId), request, { schema: threadSchema });
}

/** Create-or-get a handoff under the client-minted `request.id`; its brief runs in the background. */
export function handoffThread(
  sourceThreadId: string,
  request: HandoffThreadRequest,
): Promise<Thread> {
  return postJson(apiThreadHandoffPath(sourceThreadId), request, { schema: threadSchema });
}

/**
 * Write a new brief for a handoff destination whose latest one ended without
 * one. `request.id` is the new seed's client-minted id: a repeat returns the
 * same seed (201 new, 200 existing). 409 while anything holds the destination.
 */
export function retryHandoffBrief(
  threadId: string,
  request: HandoffBriefRetryRequest,
): Promise<Turn> {
  return postJson(apiThreadHandoffBriefPath(threadId), request, { schema: turnSchema });
}

/** Retry a latest failed reply: the server answers the same messages under `request.id`. */
export function retryReply(
  threadId: string,
  failedTurnId: string,
  request: ReplyRetryRequest,
): Promise<ReplyRetryResponse> {
  return postJson(apiThreadTurnRetryPath(threadId, failedTurnId), request);
}

export function readThreadTranscript(
  threadId: string,
  options: TranscriptPagePathOptions,
  signal?: AbortSignal,
): Promise<TranscriptPageResponse> {
  return getJson(apiThreadTranscriptPath(threadId, options), { signal });
}

export function appendUserMessage({
  data,
  signal,
}: {
  data: AppendUserMessageInput;
  signal?: AbortSignal;
}): Promise<SendMessageResponse> {
  return postJson(apiThreadMessagePath(data.threadId), data, {
    signal,
    schema: sendMessageResponseSchema,
  });
}

export function listThreadAvailableSkills(
  threadId: string,
): Promise<ThreadAvailableSkillsResponse> {
  return getJson(apiThreadSkillsPath(threadId), { schema: threadAvailableSkillsResponseSchema });
}

export function listSelectionAvailableSkills(input: {
  projectId?: string | null;
}): Promise<ThreadAvailableSkillsResponse> {
  return getJson(apiAvailableSkillsPath(input), { schema: threadAvailableSkillsResponseSchema });
}

export function lookupUserMessageAdmission(input: {
  threadId: string;
  submissionId: string;
  signal?: AbortSignal;
}): Promise<AdmissionLookup> {
  return getJson(apiThreadAdmissionPath(input.threadId, input.submissionId), {
    signal: input.signal,
    schema: admissionLookupSchema,
  });
}

export function retireUserMessageAdmission(input: {
  threadId: string;
  submissionId: string;
  signal?: AbortSignal;
}): Promise<RetireAdmissionResult> {
  return deleteJson(apiThreadAdmissionPath(input.threadId, input.submissionId), {
    signal: input.signal,
  });
}

export function cancelTurn({ data }: { data: CancelTurnInput }): Promise<CancelTurnResponse> {
  return postJson(
    apiThreadCancelPath(data.threadId, data.turnId),
    {
      reason: data.reason,
    },
    { schema: cancelTurnResponseSchema },
  );
}

export async function postCommand(path: string, body: unknown): Promise<HttpResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await readResponsePayload(response);
    return {
      status: response.status,
      body: response.ok ? deserializeTransport(payload) : payload,
    };
  } catch {
    return { status: null };
  }
}
export function enqueueThreadControl(
  threadId: string,
  request: EnqueueThreadControlRequest,
  options?: { signal?: AbortSignal },
): Promise<EnqueueThreadControlResponse> {
  return postJson(apiThreadControlsPath(threadId), request, options);
}

export function withdrawThreadControl(
  threadId: string,
  controlId: string,
): Promise<WithdrawThreadControlResponse> {
  return postJson(apiThreadControlWithdrawPath(threadId, controlId), {});
}

export function deleteThread({ data }: { data: { threadId: string } }): Promise<void> {
  return deleteRequest(apiThreadPath(data.threadId));
}

export function restoreThread(threadId: string): Promise<unknown> {
  return postJson(apiThreadRestorePath(threadId), {});
}

export async function getThreadSnapshot({
  data,
  signal,
}: {
  data: GetThreadSnapshotInput;
  signal?: AbortSignal;
}): Promise<ThreadSnapshotResponse> {
  return getJson(apiThreadSnapshotPath(data.threadId, { after: data.after }), {
    signal,
    schema: threadSnapshotSchema,
  });
}

export function updateThreadUserState(
  threadId: string,
  request: UpdateThreadUserStateRequest,
): Promise<UpdateThreadUserStateResponse> {
  return patchJson(apiThreadUserStatePath(threadId), request);
}

export function renameThread(
  threadId: string,
  request: RenameThreadRequest,
  options?: { signal?: AbortSignal },
): Promise<RenameThreadResponse> {
  return patchJson<RenameThreadResponse>(apiThreadTitlePath(threadId), request, {
    signal: options?.signal,
  });
}

export function rebindThreadWork(
  threadId: string,
  body: RebindThreadWorkRequest,
): Promise<RebindThreadWorkResponse> {
  return putJson(apiThreadWorkPath(threadId), {
    workId: body.workId,
  });
}

export function deserializeThreadSnapshot(
  response: ThreadSnapshotResponse,
): ThreadSnapshotResponse {
  return JSON.parse(
    JSON.stringify(response, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as ThreadSnapshotResponse;
}

export function getThreadModelRequestDebugRecords({
  data,
}: {
  data: { threadId: string; turnId?: string; gatewayCallId?: string };
}): Promise<ModelRequestDebugListResponse> {
  return getJson<ModelRequestDebugListResponse>(
    apiThreadModelRequestsDebugPath(data.threadId, {
      turnId: data.turnId,
      gatewayCallId: data.gatewayCallId,
    }),
  );
}

export function getThreadTurnContextPreview({
  data,
}: {
  data: { threadId: string };
}): Promise<TurnContextPreview> {
  return getJson<TurnContextPreview>(apiThreadTurnContextPreviewDebugPath(data.threadId));
}
