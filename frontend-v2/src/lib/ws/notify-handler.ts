// ═══════════════════════════════════════════════════════════════════
// Notify → TanStack Query invalidation mapping.
//
// Maps notify-lane messages (resource type + id + event) to TanStack
// Query keys, then calls invalidateQueries for each. Shared by both
// DocWsProvider and ThreadWsProvider.
//
// Notify events are idempotent invalidation hints — duplicate or
// out-of-order delivery is harmless (just triggers a refetch).
// ═══════════════════════════════════════════════════════════════════

import type { QueryClient, QueryKey } from "@tanstack/react-query"

import type { Envelope } from "./protocol"
import { RESOURCE_TYPE } from "./protocol"

// ---------------------------------------------------------------------------
// Key mapping
// ---------------------------------------------------------------------------

/**
 * Map a resource type + id + event to TanStack Query keys that
 * should be invalidated.
 *
 * Each resource type has a fixed set of related query keys.
 * The event name is available for future per-event filtering but
 * currently all events for a resource type invalidate the same keys.
 */
export function getInvalidationKeys(
  resourceType: string,
  resourceId: string,
  event: string,
): QueryKey[] {
  // Reserved for future per-event filtering (e.g. only invalidate
  // blocks on "completed", not "updated"). Currently all events for
  // a resource type invalidate the same keys.
  void event

  switch (resourceType) {
    case RESOURCE_TYPE.TURN:
      return [
        ["turns", resourceId],
        ["turns", resourceId, "blocks"],
      ]

    case RESOURCE_TYPE.THREAD:
      return [
        ["threads", resourceId],
        ["threads", resourceId, "turns"],
      ]

    case RESOURCE_TYPE.PROPOSAL:
      return [
        ["proposals", resourceId],
        ["proposals"],
      ]

    case RESOURCE_TYPE.DOCUMENT:
      return [["documents", resourceId]]

    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a notify-lane envelope by invalidating the corresponding
 * TanStack Query keys.
 *
 * Safe to call for any envelope — silently returns if the message
 * has no resource or no event payload.
 */
export function handleNotify(
  queryClient: QueryClient,
  msg: Envelope,
): void {
  const resource = msg.resource
  if (!resource) return

  const event = msg.payload?.event
  if (typeof event !== "string") return

  const keys = getInvalidationKeys(resource.type, resource.id, event)

  for (const key of keys) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}
