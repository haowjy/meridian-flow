/**
 * Who owns a branch: a Work, or a conversation lineage (a chat with no Work, its forks and
 * subagents) owning its drafts directly. The owner key is the wire and cache form.
 */
import type { ProjectId, ThreadId, WorkId } from "../ids.js";

export type DraftOwner =
  | { kind: "work"; workId: WorkId }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: ThreadId };

/** `work:<id>` or `lineage:<rootThreadId>`. */
export type DraftOwnerKey = `work:${string}` | `lineage:${string}`;

export function draftOwnerKey(
  owner: { kind: "work"; workId: string } | { kind: "lineage"; rootThreadId: string },
): DraftOwnerKey {
  return owner.kind === "work" ? `work:${owner.workId}` : `lineage:${owner.rootThreadId}`;
}

/** The kind and id a key names; null for anything else. */
export function parseDraftOwnerKey(key: string): { kind: "work" | "lineage"; id: string } | null {
  const match = /^(work|lineage):([0-9a-f-]{36})$/i.exec(key);
  return match ? { kind: match[1] as "work" | "lineage", id: match[2] as string } : null;
}

/** The owner a key names inside `projectId`; null when the key is not an owner key. */
export function draftOwnerFromKey(key: string, projectId: ProjectId): DraftOwner | null {
  const parsed = parseDraftOwnerKey(key);
  if (!parsed) return null;
  return parsed.kind === "work"
    ? { kind: "work", workId: parsed.id }
    : { kind: "lineage", projectId, rootThreadId: parsed.id };
}

/** A branch owner on the wire: the owner and how the model and writer name it (`w3`, `c12`). */
export type DraftOwnerRef = { owner: DraftOwnerKey; handle: string | null };
