/**
 * File-access wire types (file-access §3, §9): the access level the server
 * sends and the reasons every transport reports a refusal with. The policy
 * itself stays on the server; clients render what it sends.
 */

/** A file's access for the asking principal. Ranked: `read` < `edit`. */
export type FileAccessLevel = "read" | "edit";

/**
 * Why the file policy refused. `not_found` also covers deleted files and
 * files the person can't see, so existence stays hidden; `work_deleted` is said only to someone
 * who can still read the deleted Work's files.
 */
export type FileAccessDenial =
  | "not_found"
  | "work_archived"
  | "work_deleted"
  | "chat_frozen"
  | "agent_read_only"
  | "uploads_read_only"
  | "ai_access_denied";

/**
 * The `reason` on an AI tool's `permission_denied` result: a file-policy
 * refusal other than `not_found` or `work_deleted` (to the model a deleted Work's file is gone),
 * or the action policy's `action_denied`.
 */
export type PermissionDeniedReason =
  | Exclude<FileAccessDenial, "not_found" | "work_deleted">
  | "action_denied";
