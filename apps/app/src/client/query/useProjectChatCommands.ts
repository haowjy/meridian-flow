/** Shared field-scoped command lifecycle for project chat rows. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { HomeStateField } from "./home-chat-feed-cache";
import {
  getThreadUserStateTransportState,
  getThreadUserStateTransportVersion,
  runThreadUserStateCommand,
  subscribeThreadUserStateTransport,
  type ThreadUserStateLifecycle,
} from "./thread-user-state-commands";

export function useProjectChatCommands(projectId: string) {
  const client = useQueryClient();
  const transportVersion = useSyncExternalStore(
    (listener) => subscribeThreadUserStateTransport(client, listener),
    () => getThreadUserStateTransportVersion(client),
    () => 0,
  );
  const [errors, setErrors] = useState<Record<string, Error | null>>({});
  const generations = useRef(new Map<string, number>());
  const run = useCallback(
    async (
      threadId: string,
      field: HomeStateField,
      value: boolean,
      lifecycle?: ThreadUserStateLifecycle,
    ) => {
      const id = `${threadId}:${field}`;
      const generation = (generations.current.get(id) ?? 0) + 1;
      generations.current.set(id, generation);
      setErrors((current) => ({ ...current, [id]: null }));
      const outcome = await runThreadUserStateCommand(
        client,
        projectId,
        threadId,
        field,
        value,
        lifecycle,
      );
      if (generations.current.get(id) === generation)
        setErrors((current) => ({
          ...current,
          [id]: outcome.status === "error" ? outcome.error : null,
        }));
      return outcome.status === "success";
    },
    [client, projectId],
  );
  const getCommandState = useCallback(
    (threadId: string, field: HomeStateField) => ({
      ...getThreadUserStateTransportState(client, projectId, threadId, field),
      error: errors[`${threadId}:${field}`] ?? null,
    }),
    [client, errors, projectId, transportVersion],
  );
  return {
    setFavorite: (threadId: string, value: boolean, lifecycle?: ThreadUserStateLifecycle) =>
      run(threadId, "isFavorite", value, lifecycle),
    setUnread: (threadId: string, value: boolean) => run(threadId, "isUnread", value),
    getCommandState,
  };
}
