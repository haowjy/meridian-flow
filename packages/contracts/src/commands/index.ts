import { z } from "zod";
import type { CommandId } from "../ids.js";

export const CommandIdSchema = z.string().uuid();

export type CommandBody<T extends object = object> = T & { commandId: CommandId };

export const COMMAND_KINDS = [
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
  "project_rename",
  "thread_set_overrides",
  "chat_rename",
  "press",
  "unpress",
  "draft_create",
  "draft_rename",
  "draft_delete",
  "draft_restore",
  "chat_draft",
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export const COMMAND_CONFLICT_CODE = "command_conflict";

export const WRONG_ACCOUNT_CODE = "wrong_account";

export const EXPECTED_ACCOUNT_HEADER = "x-meridian-account";

export type CommandOutcome<R = StoredResult> =
  | { status: "done" | "refused"; result: R }
  | { status: "never" };

export type Settlement =
  | { rule: "already"; state: string; item?: string }
  | {
      rule: "returned";
      why: ReturnedWhy;
      items?: string[];
    }
  | { rule: "overtaken"; state: string; item?: string }
  | { rule: "left_out"; items: string[]; why: LeftOutWhy; tree?: boolean }
  | { rule: "restored"; documentId: string };

export type LeftOutWhy =
  | "would_loop"
  | "purged"
  | "after_press"
  | "needs"
  | "changed_since"
  | "closed"
  | "already";

export type ReturnedWhy = ClosedOwnerWhy | "document_removed" | "block_gone";

export const CLOSED_OWNER_WHYS = ["work_archived", "work_deleted", "chat_frozen"] as const;
export type ClosedOwnerWhy = (typeof CLOSED_OWNER_WHYS)[number];

export type StoredResult = { settled?: Settlement[] };

export type CommandLookupResponse =
  | { status: "none" }
  | { status: "stored"; kind: CommandKind; outcome: CommandOutcome };

export type CommandResolveResponse = { commandId: string; outcome: CommandOutcome };
