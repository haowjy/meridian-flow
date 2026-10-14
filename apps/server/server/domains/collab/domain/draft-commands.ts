/**
 * The command record (contract §4.6): one writer command, one effect. The service looks a
 * `commandId` up before it resolves anything, the effect transaction claims it as its first
 * write, and the step that makes the command terminal stores its result. `blocked` is never
 * stored: it is derived from the command's batch.
 */
import { createHash } from "node:crypto";
import type { DraftCommandId, DraftId, UserId, WorkId } from "@meridian/contracts";
import type { DraftCommandKind, DraftCommandOutcome } from "@meridian/contracts/drafts";

/** Who sent which command and what it said: the identity a resend must match exactly. */
export type DraftCommandEnvelope = {
  commandId: DraftCommandId;
  workId: WorkId;
  accountId: UserId;
  kind: DraftCommandKind;
  draftId: DraftId | null;
  /** `commandDigest` of the canonical envelope. */
  digest: string;
};

/** Canonical hash of the whole envelope: account, project, Work, kind, selectors and body. */
export function commandDigest(envelope: {
  accountId: string;
  projectId: string;
  workId: string;
  kind: DraftCommandKind;
  selectors: Record<string, string | null>;
  body: unknown;
}): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type CommandLookup =
  | { kind: "none" }
  /** Another digest, Work or account under this id: reveals nothing. */
  | { kind: "conflict" }
  | { kind: "pending"; draftId: DraftId | null }
  | { kind: "done"; commandKind: DraftCommandKind; result: DraftCommandOutcome }
  | { kind: "blocked" };

/** What a lookup needs; the observation route has no body to digest, so it names none. */
export type CommandLookupKey = Pick<DraftCommandEnvelope, "commandId" | "workId" | "accountId"> & {
  digest?: string;
};

export interface DraftCommands {
  /** Fresh and authenticated: the account and Work the key names are all it reads. */
  lookup(key: CommandLookupKey): Promise<CommandLookup>;
  /**
   * Stores a terminal outcome decided where nothing else commits (a refusal before any lease, or
   * the staging that found nothing to stage), in its own small transaction. The loser of a race
   * on the id writes nothing: the caller answers the winner's row (§1.4).
   */
  record(envelope: DraftCommandEnvelope, result: DraftCommandOutcome): Promise<void>;
}

/** The id is already taken by a committed or in-flight command: the caller answers that one. */
export class DraftCommandExistsError extends Error {
  constructor(readonly commandId: DraftCommandId) {
    super(`Command ${commandId} already has an effect`);
    this.name = "DraftCommandExistsError";
  }
}
