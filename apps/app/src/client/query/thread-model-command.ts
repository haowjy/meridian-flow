/**
 * The set-model command kind: run this chat's Agent on another model, or back on its own. The
 * command driver delivers it. The server never refuses it: an id the gateway doesn't list is
 * stored and falls back to the Agent's model at turn time.
 */
import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import { apiThreadModelPath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { threadQueryKeys } from "./thread-query-keys";

export const THREAD_SET_MODEL_KIND = "thread_set_model";

/** `model: null` clears the override. */
export type ThreadSetModelBody = { threadId: string; model: string | null };

/** Lane of one chat's set-model commands, so the last one the writer made is the last one stored. */
export const threadModelLane = (threadId: string) => `thread-model:${threadId}`;

/**
 * The model a chat shows: the writer's newest unrefused change (so a pick shows at once and
 * stays through delivery), else what the server's thread read says.
 */
export function projectThreadModel(
  records: readonly CommandRecord[],
  threadId: string,
  serverModel: string | null,
): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record?.kind !== THREAD_SET_MODEL_KIND || record.state === "never") continue;
    const body = record.body as ThreadSetModelBody;
    if (body.threadId === threadId) return body.model;
  }
  return serverModel;
}

export function threadModelDomain(client: QueryClient): CommandDomain {
  let bound: CommandDriver | null = null;
  // A settled change stops overriding the server's value once a snapshot read that began after
  // it succeeds; until then the driver keeps the record, so the pick never flickers back.
  const observeSettled = (threadId: string, before: number) =>
    void bound?.observe(
      (record) =>
        record.kind === THREAD_SET_MODEL_KIND &&
        (record.body as ThreadSetModelBody).threadId === threadId &&
        record.settledAt !== undefined &&
        record.settledAt <= before,
    );
  const kinds: Record<string, CommandKind> = {
    [THREAD_SET_MODEL_KIND]: {
      version: 1,
      migrate: (body) => body as ThreadSetModelBody,
      request: ({ body }) => {
        const { threadId, model } = body as ThreadSetModelBody;
        return { method: "PATCH", path: apiThreadModelPath(threadId), body: { model } };
      },
      onSettled: (record) => {
        const { threadId } = record.body as ThreadSetModelBody;
        const queryKey = threadQueryKeys.snapshot(threadId);
        const startedAt = Date.now();
        // No snapshot in this tab: nothing shows the record, so the server's value is the truth.
        if (!client.getQueryState(queryKey)) return observeSettled(threadId, startedAt);
        void client.refetchQueries({ queryKey }).then(() => {
          if (client.getQueryState(queryKey)?.status === "success")
            observeSettled(threadId, startedAt);
        });
      },
    },
  };
  return {
    kinds,
    bind: (driver) => {
      bound = driver;
      return () => {
        if (bound === driver) bound = null;
      };
    },
  };
}
