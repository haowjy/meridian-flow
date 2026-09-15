/**
 * ConversationSection — which thread the project currently treats as active,
 * and how that was resolved. Nothing else.
 *
 * Deliberately minimal. Everything richer is delegated to a tool that already
 * does it well, so this section owns only the one signal none of them surface:
 *  - per-turn/block records → alt+click inline inspect (`InlineInspector`).
 *  - lifecycle / `actionRequired` / `runningTurnId` → TanStack Query Devtools
 *    (inspect the `["projects", projectId, "threads"]` query).
 *  - raw WS frames → Chrome DevTools → Network → WS → Messages.
 *
 * Streaming identity and standalone route identity remain IDs. Project routes
 * show their readable address; resolve IDs in the existing Query Devtools.
 *
 * Reads only the thread store + router location — neither notifies during
 * another component's render, so this section needs no query-cache subscription
 * and carries none of the setState-in-render hazard the old lifecycle
 * projection did.
 *
 * i18n exception: DEV-only.
 */

import { useRouterState } from "@tanstack/react-router";

import { useThreadStore } from "@/client/stores";

import { JsonTree } from "../JsonTree";

function useRouteThreadId(): string | null {
  // Standalone chats intentionally keep their ID-addressed route.
  const location = useRouterState({ select: (s) => s.location });
  if (!location) return null;
  try {
    const path = location.pathname || "";
    const chatMatch = path.match(/^\/chat\/([^/?#]+)/);
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
