import { createHash } from "node:crypto";
import type { CommandId, ProjectId, ThreadId, UserId } from "@meridian/contracts";
import type { CommandKind, CommandOutcome } from "@meridian/contracts/commands";

export type CommandEnvelope = {
  commandId: CommandId;
  accountId: UserId;
  projectId: ProjectId;
  threadId?: ThreadId;
  kind: CommandKind;
  digest: string;
};

export function commandDigest(envelope: {
  accountId: string;
  projectId: string;
  draftId?: string;
  kind: CommandKind;
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
  | { kind: "conflict" }
  | { kind: "stored"; commandKind: CommandKind; outcome: CommandOutcome };

export type CommandLookupKey = Pick<CommandEnvelope, "commandId" | "accountId"> & {
  digest?: string;
};

export function replay<R>(
  found: CommandLookup,
  commandId: CommandId,
): R | { status: "conflict"; commandId: CommandId } | null {
  if (found.kind === "none") return null;
  if (found.kind === "conflict" || found.outcome.status === "never")
    return { status: "conflict", commandId };
  return found.outcome.result as R;
}

export class CommandExistsError extends Error {
  constructor(readonly commandId: CommandId) {
    super(`Command ${commandId} already has an effect`);
    this.name = "CommandExistsError";
  }
}

export class CommandConflictError extends Error {
  constructor(readonly commandId: CommandId) {
    super(`Command ${commandId} was used for a different command`);
    this.name = "CommandConflictError";
  }
}
