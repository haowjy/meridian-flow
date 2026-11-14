/** The document side of the command record (`shared/commands`): its port and its statuses. */
import type { StoredDocumentCommandResult } from "@meridian/contracts/branches";
import type {
  CommandEnvelope,
  CommandLookup,
  CommandLookupKey,
} from "../../../shared/commands/command-record.js";

export interface DocumentCommands {
  /** Fresh and authenticated: the account and digest the key names are all it reads. */
  lookup(key: CommandLookupKey): Promise<CommandLookup>;
  /**
   * Claims the id and runs the effect in one transaction that holds no second connection.
   * An id already taken throws `CommandExistsError`.
   */
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
  "reversed",
  "copied",
]);

/** `done` when the effect committed; every other answer is a refusal that changed nothing. */
export function documentOutcomeOf(result: { status: string }): "done" | "refused" {
  return DONE_STATUSES.has(result.status) ? "done" : "refused";
}
