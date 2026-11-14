/**
 * The command record: one writer command, one effect, one row in `document_commands`. The
 * effect transaction claims the id as its first write and stores its outcome before it commits,
 * so a committed row always holds the final answer and a resend reads it.
 */
import { createHash } from "node:crypto";
import type { DocumentCommandId, ProjectId, UserId } from "@meridian/contracts";
import type {
  DocumentCommandKind,
  DocumentCommandOutcome,
  StoredDocumentCommandResult,
} from "@meridian/contracts/branches";

/** Who sent which command and what it said: the identity a resend must match exactly. */
export type DocumentCommandEnvelope = {
  commandId: DocumentCommandId;
  accountId: UserId;
  projectId: ProjectId;
  kind: DocumentCommandKind;
  /** `commandDigest` of the canonical envelope; it covers the branch. */
  digest: string;
};

/** Canonical hash of the whole envelope: account, project, branch, kind, selectors and body. */
export function commandDigest(envelope: {
  accountId: string;
  projectId: string;
  branchId: string;
  kind: DocumentCommandKind;
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
  /** Another digest or account under this id: reveals nothing. */
  | { kind: "conflict" }
  | { kind: "stored"; commandKind: DocumentCommandKind; outcome: DocumentCommandOutcome };

/** What a lookup needs; the observation route has no body to digest, so it names none. */
export type CommandLookupKey = Pick<DocumentCommandEnvelope, "commandId" | "accountId"> & {
  digest?: string;
};

export interface DocumentCommands {
  /** Fresh and authenticated: the account and digest the key names are all it reads. */
  lookup(key: CommandLookupKey): Promise<CommandLookup>;
}

/** The answer a resend gets from a lookup: what was stored, or `conflict`; null when nothing is. */
export function replay<R extends StoredDocumentCommandResult>(
  found: CommandLookup,
  commandId: DocumentCommandId,
): R | { status: "conflict"; commandId: DocumentCommandId } | null {
  if (found.kind === "none") return null;
  if (found.kind === "conflict" || found.outcome.status === "never")
    return { status: "conflict", commandId };
  return found.outcome.result as R;
}

const DONE_STATUSES: ReadonlySet<string> = new Set(["applied", "unapplied", "discarded", "edited"]);

/** `done` when the effect committed; every other answer is a refusal that changed nothing. */
export function outcomeOf(result: StoredDocumentCommandResult): DocumentCommandOutcome {
  return { status: DONE_STATUSES.has(result.status) ? "done" : "refused", result };
}

/** The id is already taken by a committed command: the caller answers that one. */
export class DocumentCommandExistsError extends Error {
  constructor(readonly commandId: DocumentCommandId) {
    super(`Command ${commandId} already has an effect`);
    this.name = "DocumentCommandExistsError";
  }
}
