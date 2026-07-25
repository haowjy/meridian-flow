/** Projects committed trail replace-sets into bounded live-session change events. */

import type { AgentEditCodec } from "@meridian/agent-edit/integration";
import type { ChangeEventProjection, ChangeEventWsMessage } from "@meridian/contracts/protocol";
import type { CommittedChangeTrailProjection } from "./ports/change-trail-persistence.js";
import { bodyFromHashline } from "./trail-read-kernel.js";

export function projectCommittedChangeEvent(
  projection: CommittedChangeTrailProjection,
  sweptChangeIds: ReadonlySet<string>,
  codec: AgentEditCodec,
): Omit<ChangeEventWsMessage, "type"> {
  const capped = projection.changes.slice(0, 100);
  return {
    documentId: projection.documentId as ChangeEventWsMessage["documentId"],
    threadId: projection.owner.threadId,
    trailId: projection.trailId,
    projectionRevision: projection.projectionRevision,
    author: {
      kind: "agent",
      threadId: projection.owner.threadId,
      turnId: projection.owner.kind === "turn" ? projection.owner.turnId : null,
    },
    changes: capped.map((change) =>
      projectChange(change, sweptChangeIds.has(change.changeId), codec),
    ),
    truncated: projection.changes.length > capped.length,
  };
}

function projectChange(
  change: CommittedChangeTrailProjection["changes"][number],
  swept: boolean,
  codec: AgentEditCodec,
): ChangeEventProjection {
  const hashline = change.kind === "delete" ? change.beforeText : change.afterTextAtReceipt;
  const body = bodyFromHashline(hashline);
  const text = body.status === "available" ? body.markdown : null;
  return {
    changeId: change.changeId,
    admittedByUserId: change.admittedByUserId,
    kind: change.kind,
    navigation: change.navigation,
    swept,
    excerpt: text === null ? null : text.slice(0, 500),
    pureDeletionOffset:
      change.kind === "modify"
        ? detectPureDeletionOffset(
            renderedBodyText(change.beforeText, codec),
            renderedBodyText(change.afterTextAtReceipt, codec),
          )
        : null,
  };
}

/** Returns the splice site when `after` is exactly `before` minus one contiguous span. */
export function detectPureDeletionOffset(
  before: string | null,
  after: string | null,
): number | null {
  if (before === null || after === null || after.length >= before.length) return null;
  let prefix = 0;
  while (prefix < after.length && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return before.slice(0, prefix) + before.slice(before.length - suffix) === after ? prefix : null;
}

export function renderedBodyText(hashline: string | null, codec: AgentEditCodec): string | null {
  const body = bodyFromHashline(hashline);
  if (body.status !== "available") return null;
  try {
    return codec.parse(body.markdown).blocks[0]?.textContent ?? null;
  } catch {
    // A malformed historical body must not suppress the rest of the marker set.
    return null;
  }
}
