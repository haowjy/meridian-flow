/**
 * The command record (contract §4.6): one writer command, one effect. The service looks a
 * `commandId` up before it resolves anything, the effect transaction claims it as its first
 * write, and the effect transaction stores its result.
 */
import { createHash } from "node:crypto";
import type { BranchCommandId, BranchId, UserId, WorkId } from "@meridian/contracts";
import type { BranchCommandKind, StoredBranchCommandResult } from "@meridian/contracts/branches";

/** Who sent which command and what it said: the identity a resend must match exactly. */
export type BranchCommandEnvelope = {
  commandId: BranchCommandId;
  workId: WorkId;
  accountId: UserId;
  kind: BranchCommandKind;
  branchId: BranchId | null;
  /** `commandDigest` of the canonical envelope. */
  digest: string;
};

/** Canonical hash of the whole envelope: account, project, Work, kind, selectors and body. */
export function commandDigest(envelope: {
  accountId: string;
  projectId: string;
  workId: string;
  kind: BranchCommandKind;
  selectors: Record<string, string | null>;
  body: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ...envelope,
        kind: envelope.kind === "discard_branch" ? "discard_draft" : envelope.kind,
      }),
    )
    .digest("hex");
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
  /** Another digest, Work or account under this id: reveals nothing. */
  | { kind: "conflict" }
  | { kind: "pending"; branchId: BranchId | null }
  | { kind: "done"; commandKind: BranchCommandKind; result: StoredBranchCommandResult };

/** What a lookup needs; the observation route has no body to digest, so it names none. */
export type CommandLookupKey = Pick<BranchCommandEnvelope, "commandId" | "workId" | "accountId"> & {
  digest?: string;
};

export interface BranchCommands {
  /** Fresh and authenticated: the account and Work the key names are all it reads. */
  lookup(key: CommandLookupKey): Promise<CommandLookup>;
}

/** The id is already taken by a committed or in-flight command: the caller answers that one. */
export class BranchCommandExistsError extends Error {
  constructor(readonly commandId: BranchCommandId) {
    super(`Command ${commandId} already has an effect`);
    this.name = "BranchCommandExistsError";
  }
}
