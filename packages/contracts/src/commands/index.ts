/** The command record's wire contracts: one id per request, one stored outcome per id. */
import { z } from "zod";
import type { CommandId } from "../ids.js";

/** A UUID the client mints once per writer command; resends reuse it (contract §4.6). */
export const CommandIdSchema = z.string().uuid();

/** A request body that is a command: the sender's fields plus the id it minted once. */
export type CommandBody<T extends object = object> = T & { commandId: CommandId };

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
  "thread_set_overrides",
  "press",
  "unpress",
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
export type CommandOutcome<R = StoredResult> =
  | { status: "done" | "refused"; result: R }
  | { status: "never" };

/**
 * Where a done command's result differs from what was asked: `result.settled` on a done outcome,
 * absent when it landed as asked.
 * `already`: the asked state held before the command ran (a second press, or another tab did it).
 * `returned`: the command would add words to something closed, so nothing changed; the result
 * carries the subject as it stands and `why` names how it is closed.
 */
export type Settlement =
  | { rule: "already"; state: string; item?: string }
  | {
      rule: "returned";
      why: ReturnedWhy;
      /** On an Un-Apply: the nodes it left as the Apply left them, for `why`. */
      items?: string[];
    }
  /** Another command settled the item first, so this one left it as that left it. */
  | { rule: "overtaken"; state: string; item?: string }
  /**
   * Part of the command could not land: `items` name what was left out. On an Un-Apply, `tree`
   * says whether the items' tree facts stayed or their text.
   */
  | { rule: "left_out"; items: string[]; why: LeftOutWhy; tree?: boolean }
  /** A deleted document came back (it was in Trash) so the command could land. */
  | { rule: "restored"; documentId: string };

/** Why items were left out of a command (the tree package's `LeftWhy` and `UndoLeftWhy`, and a purge). */
export type LeftOutWhy =
  | "would_loop"
  | "purged"
  | "after_press"
  | "needs"
  | "changed_since"
  | "has_text"
  | "closed"
  | "already";

/**
 * Why an act was returned. The first three close the owner of the drafts (a Work, or a chat in
 * Trash); the rest are a model's edit that cannot
 * land: its document was removed, or the block it named is gone.
 */
export type ReturnedWhy = ClosedOwnerWhy | "document_removed" | "block_gone";

/** The reasons that name a closed owner of drafts: in a `returned` act, a 4409 close and a read-only room's scope. */
export const CLOSED_OWNER_WHYS = ["work_archived", "work_deleted", "chat_frozen"] as const;
export type ClosedOwnerWhy = (typeof CLOSED_OWNER_WHYS)[number];

/** What a stored command result may carry beyond its own fields. */
export type StoredResult = { settled?: Settlement[] };

/**
 * A resend's answer while the first request under its id is still running: nothing is known yet,
 * and sending it again waits on that request for its answer.
 */
export type CommandRunning = { status: "running"; commandId: string };

/** `GET /api/commands/:id`: the stored outcome, or `none` (also for another account's id). */
export type CommandLookupResponse =
  | { status: "none" }
  | { status: "stored"; kind: CommandKind; outcome: CommandOutcome };

/** `POST /api/commands/:id/resolve`: the stored outcome, or the `never` the call just stored. */
export type CommandResolveResponse = { commandId: string; outcome: CommandOutcome };
