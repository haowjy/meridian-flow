/**
 * The writer's connections, as the server resolves them for a project (or the account alone).
 * Reading the list is what starts the server's checks that are due, so the app reads it when it
 * opens, when the writer comes back, and while a screen shows a connection that isn't working.
 * The server's `mcp-connections-hint` makes it stale (`useProjectWake`).
 */
import type { McpConnectionView } from "@meridian/contracts/mcp";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { listMcpConnections } from "@/client/api/mcp-api";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";

export const mcpConnectionsRoot = (accountId: string) =>
  ["account", accountId, "mcp-connections"] as const;
const mcpConnectionsKey = (accountId: string, projectId: string | null) =>
  [...mcpConnectionsRoot(accountId), projectId ?? "account"] as const;

/** The server checks a connection at most once a minute: asking sooner learns nothing new. */
const CHECK_INTERVAL_MS = 60_000;
/** A check takes a few seconds and up to two tries; outside a project no hint says it finished. */
const CHECKING_POLL_MS = 4_000;

/**
 * `watch`: this observer shows the statuses, so it asks again while one is being checked, and
 * once a minute while one can't be reached. A refused token waits for the writer.
 */
export function useMcpConnections(projectId: string | null, { watch = false } = {}) {
  const accountId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  return useQuery({
    queryKey: mcpConnectionsKey(accountId, projectId),
    queryFn: ({ signal }) =>
      listMcpConnections(AbortSignal.any([accountSignal, signal]), projectId),
    staleTime: CHECK_INTERVAL_MS,
    refetchInterval: watch
      ? (query) => {
          const connections = query.state.data ?? [];
          if (connections.some((connection) => connection.status === null)) return CHECKING_POLL_MS;
          if (connections.some((connection) => connection.status === "unreachable"))
            return CHECK_INTERVAL_MS;
          return false;
        }
      : false,
  });
}

/** The project the writer is in, if any: the Connections list of a project shows its own as well. */
export function useRouteProjectId(): string | null {
  const params = useParams({ strict: false }) as { projectId?: string };
  return params.projectId ?? null;
}

/** Reads the list when the app opens and when the writer comes back, so a check starts. */
export function useMcpConnectionsAtOpen(): void {
  useMcpConnections(useRouteProjectId());
}

export function invalidateMcpConnections(queryClient: QueryClient, accountId: string) {
  return queryClient.invalidateQueries({ queryKey: mcpConnectionsRoot(accountId) });
}

/**
 * Writes what the writer just did into every list that holds the connection, then asks again.
 * A single connection's answer carries no shadow, so the list's own is kept.
 */
export function useMcpConnectionCache() {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const update = useCallback(
    (id: string, change: (connection: McpConnectionView) => McpConnectionView | null) => {
      queryClient.setQueriesData<McpConnectionView[]>(
        { queryKey: mcpConnectionsRoot(accountId) },
        (list) =>
          list?.flatMap((connection) => {
            if (connection.id !== id) return [connection];
            const next = change(connection);
            return next ? [next] : [];
          }),
      );
    },
    [queryClient, accountId],
  );
  const put = useCallback(
    (view: McpConnectionView) =>
      update(view.id, (connection) => ({ ...view, shadowedBy: connection.shadowedBy })),
    [update],
  );
  const insert = useCallback(
    (projectId: string | null, view: McpConnectionView) => {
      queryClient.setQueryData<McpConnectionView[]>(
        mcpConnectionsKey(accountId, projectId),
        (list) => (list ? [...list.filter((item) => item.id !== view.id), view] : list),
      );
    },
    [queryClient, accountId],
  );
  const refresh = useCallback(
    () => invalidateMcpConnections(queryClient, accountId),
    [queryClient, accountId],
  );
  return { update, put, insert, refresh };
}
