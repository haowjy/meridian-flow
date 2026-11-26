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

const CHECK_INTERVAL_MS = 60_000;
const CHECKING_POLL_MS = 4_000;

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

export function useRouteProjectId(): string | null {
  const params = useParams({ strict: false }) as { projectId?: string };
  return params.projectId ?? null;
}

export function useMcpConnectionsAtOpen(): void {
  useMcpConnections(useRouteProjectId());
}

export function invalidateMcpConnections(queryClient: QueryClient, accountId: string) {
  return queryClient.invalidateQueries({ queryKey: mcpConnectionsRoot(accountId) });
}

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
