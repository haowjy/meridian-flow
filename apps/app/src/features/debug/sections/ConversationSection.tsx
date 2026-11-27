import { useRouterState } from "@tanstack/react-router";

import { useThreadStore } from "@/client/stores";

import { JsonTree } from "../JsonTree";

function useRouteThreadId(): string | null {
  const location = useRouterState({ select: (s) => s.location });
  if (!location) return null;
  try {
    const path = location.pathname || "";
    const chatMatch = path.match(/^\/p\/[^/?#]+\/chat\/([^/?#]+)/);
    if (chatMatch) return decodeURIComponent(chatMatch[1]);
    return null;
  } catch {
    return null;
  }
}

export function ConversationSection() {
  const streamingThreadId = useThreadStore((s) => s.streamingThreadId);
  const streamingProjectId = useThreadStore((s) => s.streamingProjectId);
  const routeThreadId = useRouteThreadId();
  const routeAddress = useRouterState({ select: (state) => state.location.href });
  const activeThreadId = streamingThreadId ?? routeThreadId;

  return (
    <JsonTree
      value={{
        resolvedActiveThreadId: activeThreadId,
        source: streamingThreadId ? "streamingThreadId" : routeThreadId ? "route" : null,
        streamingThreadId,
        streamingProjectId,
        routeThreadId,
        routeAddress,
      }}
    />
  );
}
