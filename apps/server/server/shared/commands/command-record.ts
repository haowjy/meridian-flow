/**
 * The command record: one request, one effect, one row in `commands`. The effect transaction
 * claims the id as its first write and stores its outcome before it commits, so a committed row
 * always holds the final answer and a resend reads it. Every kind (document, Work, project, the
 * runtime's) goes through this one claim; the kinds own only their effect and their statuses.
 */
import { createHash } from "node:crypto";
import type { CommandId, ProjectId, ThreadId, UserId } from "@meridian/contracts";
import type { CommandKind, CommandOutcome } from "@meridian/contracts/commands";

/** Who sent which command and what it said: the identity a resend must match exactly. */
export type CommandEnvelope = {
  commandId: CommandId;
  accountId: UserId;
  projectId: ProjectId;
  /** Set for a `model_edit`: its chat. */
  threadId?: ThreadId;
  kind: CommandKind;
  /** `commandDigest` of the canonical envelope. */
  digest: string;
};

/** Canonical hash of the whole envelope: account, project, kind, selectors and body. */
export function commandDigest(envelope: {
  accountId: string;
  projectId: string;
  branchId?: string;
  kind: CommandKind;
  selectors: Record<string, string | null>;
  body: unknown;
}): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

// These spellings are the persisted fingerprint encoding, not API vocabulary. Receipts store
// only the hash, so a terminology change cannot translate their original envelopes afterwards.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]): [string, unknown] => [key === "branchId" ? "draftId" : key, item])
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type CommandLookup =
  | { kind: "none" }
  /** Another account or digest under this id: reveals nothing. */
  | { kind: "conflict" }
  | { kind: "stored"; commandKind: CommandKind; outcome: CommandOutcome };

/** What a lookup needs; the observation route has no body to digest, so it names none. */
export type CommandLookupKey = Pick<CommandEnvelope, "commandId" | "accountId"> & {
  digest?: string;
};

/**
 * The answer a resend gets from a lookup: what was stored, or `conflict`; null when nothing is.
 * A `never` row answers `conflict` here: an old-shape route has no `never` to say, and the id
 * was never going to take effect for this sender either way.
 */
export function replay<R>(
  found: CommandLookup,
  commandId: CommandId,
): R | { status: "conflict"; commandId: CommandId } | null {
  if (found.kind === "none") return null;
  if (found.kind === "conflict" || found.outcome.status === "never")
    return { status: "conflict", commandId };
  return found.outcome.result as R;
}

/** The id is already taken by a committed command: the caller answers that one. */
export class CommandExistsError extends Error {
  constructor(readonly commandId: CommandId) {
    super(`Command ${commandId} already has an effect`);
    this.name = "CommandExistsError";
  }
}

/** The id was used by another account or for a different request: a bug in the client. */
export class CommandConflictError extends Error {
  constructor(readonly commandId: CommandId) {
    super(`Command ${commandId} was used for a different command`);
    this.name = "CommandConflictError";
  }
}
