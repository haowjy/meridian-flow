/**
 * ConversationSection — which thread the project currently treats as active,
 * and how that was resolved. Nothing else.
 *
 * Deliberately minimal. Everything richer is delegated to a tool that already
 * does it well, so this section owns only the one signal none of them surface:
 *  - per-turn/block records → alt+click inline inspect (`InlineInspector`).
 *  - lifecycle / `attention` / `runningTurnId` → TanStack Query Devtools
 *    (inspect the `["projects", projectId, "threads"]` query).
 *  - raw WS frames → Chrome DevTools → Network → WS → Messages.
 *
 * Resolution order: `streamingThreadId` (primary) → route (`/chat/$threadId`
 * path param, or the project route's `?thread=…` search param — note `thread`,
 * not `threadId`) → none.
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
  // Unconditional hook (Rules of Hooks). Defensive parsing tolerates shape
  // changes in `location.search` from the concurrent product-lift track.
  const location = useRouterState({ select: (s) => s.location });
  if (!location) return null;
  try {
    const path = location.pathname || "";
    const chatMatch = path.match(/^\/chat\/([^/?#]+)/);
    if (chatMatch) return decodeURIComponent(chatMatch[1]);
    const search = location.search as Record<string, unknown> | undefined;
    const t = search?.thread;
    if (typeof t === "string" && t.length > 0) return t;
    return null;
  } catch {
    return null;
  }
}

export function ConversationSection() {
  const streamingThreadId = useThreadStore((s) => s.streamingThreadId);
  const streamingProjectId = useThreadStore((s) => s.streamingProjectId);
  const routeThreadId = useRouteThreadId();
  const activeThreadId = streamingThreadId ?? routeThreadId;

  return (
    <JsonTree
      value={{
        resolvedActiveThreadId: activeThreadId,
        source: streamingThreadId ? "streamingThreadId" : routeThreadId ? "route" : null,
        streamingThreadId,
        streamingProjectId,
        routeThreadId,
      }}
    />
  );
}
