/** The command record's wire contracts: one id per request, one stored outcome per id. */
import { z } from "zod";

/** A UUID the client mints once per writer command; resends reuse it (contract §4.6). */
export const CommandIdSchema = z.string().uuid();

/** Which kind of command a `commandId` was recorded for. */
export const COMMAND_KINDS = [
  "apply",
  "unapply",
  "discard",
  "undo_discard",
  "model_edit",
  "reverse_turn",
  "copy",
  "work_create",
  "work_update",
  "work_archive",
  "work_unarchive",
  "work_delete",
  "work_restore",
  "project_create",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** HTTP 409 code: the `commandId` was already used for a different command. */
export const COMMAND_CONFLICT_CODE = "command_conflict";

/** HTTP 409 code: the request names an account other than the signed-in one; nothing ran. */
export const WRONG_ACCOUNT_CODE = "wrong_account";

/** Request header naming the account the sender believes it is signed in as. */
export const EXPECTED_ACCOUNT_HEADER = "x-meridian-account";

/**
 * The outcome a command's transaction commits. `done`: the effect committed. `refused`: the
 * effect was turned away after the claim and nothing of it committed. `never`: the id was
 * claimed so that no attempt under it can take effect.
 */
export type CommandOutcome<R = unknown> =
  | { status: "done" | "refused"; result: R }
  | { status: "never" };

/** `GET /api/commands/:id`: the stored outcome, or `none` (also for another account's id). */
export type CommandLookupResponse =
  | { status: "none" }
  | { status: "stored"; kind: CommandKind; outcome: CommandOutcome };

/** `POST /api/commands/:id/resolve`: the stored outcome, or the `never` the call just stored. */
export type CommandResolveResponse = { commandId: string; outcome: CommandOutcome };
