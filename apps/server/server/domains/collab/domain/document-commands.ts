import type { StoredDocumentCommandResult } from "@meridian/contracts/drafts";
import type {
  CommandEnvelope,
  CommandLookup,
  CommandLookupKey,
} from "../../../shared/commands/command-record.js";

export interface DocumentCommands {
  lookup(key: CommandLookupKey): Promise<CommandLookup>;
  await(envelope: CommandEnvelope): Promise<CommandLookup | { kind: "running" }>;
  run<R extends StoredDocumentCommandResult>(
    envelope: CommandEnvelope,
    effect: () => Promise<R>,
    refusal?: (cause: unknown) => R | undefined,
  ): Promise<R>;
}

const DONE_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "unapplied",
  "restored",
  "discarded",
  "edited",
  "returned",
  "reversed",
  "copied",
  "pressed",
  "unpressed",
]);

export function documentOutcomeOf(result: { status: string }): "done" | "refused" {
  return DONE_STATUSES.has(result.status) ? "done" : "refused";
}
