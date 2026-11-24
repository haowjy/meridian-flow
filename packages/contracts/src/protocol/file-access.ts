export type FileAccessLevel = "read" | "edit";

export type FileAccessDenial =
  | "not_found"
  | "work_archived"
  | "work_deleted"
  | "chat_frozen"
  | "agent_read_only"
  | "uploads_read_only"
  | "ai_access_denied";

export type PermissionDeniedReason =
  | Exclude<FileAccessDenial, "not_found" | "work_deleted">
  | "action_denied";
