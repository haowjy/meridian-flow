import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import { apiThreadOverridesPath } from "@meridian/contracts/protocol";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { threadQueryKeys } from "./thread-query-keys";
import { whenRead } from "./when-read";

export const THREAD_SET_OVERRIDES_KIND = "thread_set_overrides";

export type ThreadSetOverridesBody = { threadId: string; overrides: ThreadOverrides };

export const threadOverridesLane = (threadId: string) => `thread-overrides:${threadId}`;

export function projectThreadOverrides(
  records: readonly CommandRecord[],
  threadId: string,
  server: ThreadOverrides,
): ThreadOverrides {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (
      record?.kind !== THREAD_SET_OVERRIDES_KIND ||
      record.state === "never" ||
      (record.state === "done" && record.observed)
    )
      continue;
    const body = record.body as ThreadSetOverridesBody;
    if (body.threadId === threadId) return body.overrides;
  }
  return server;
}

export function threadOverridesDomain(client: QueryClient): CommandDomain {
  let bound: CommandDriver | null = null;
  // A settled change stops overriding the server's value once a snapshot read that began after
  // it succeeds; until then the driver keeps the record, so the pick never flickers back.
  const observeSettled = (threadId: string, before: number) =>
    void bound?.observe(
      (record) =>
        record.kind === THREAD_SET_OVERRIDES_KIND &&
        (record.body as ThreadSetOverridesBody).threadId === threadId &&
        record.settledAt !== undefined &&
        record.settledAt <= before,
    );
  const kinds: Record<string, CommandKind> = {
    [THREAD_SET_OVERRIDES_KIND]: {
      version: 1,
      migrate: (body) => body as ThreadSetOverridesBody,
      request: ({ body }) => {
        const { threadId, overrides } = body as ThreadSetOverridesBody;
        return { method: "PATCH", path: apiThreadOverridesPath(threadId), body: { overrides } };
      },
      onSettled: (record) => {
        const { threadId } = record.body as ThreadSetOverridesBody;
        const queryKey = threadQueryKeys.snapshot(threadId);
        const startedAt = Date.now();
        void whenRead(client, { queryKey }).then(() => observeSettled(threadId, startedAt));
        void client.refetchQueries({ queryKey });
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
