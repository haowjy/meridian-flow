/**
 * Model-facing copy for file-policy refusals (file-access §9).
 * A refusal that suggests a call writes it exactly, and only when the agent
 * may make it; otherwise it says to ask the user.
 */
import {
  type DocumentCommandName,
  modelResult,
  removedFile,
} from "@meridian/agent-edit/integration";
import type { DocumentRemovalRecord, FileAccessDenial } from "@meridian/contracts/protocol";
import type { FileAccessDenied } from "../domains/file-policy/index.js";
import type { WriteToolErrorOutput } from "./model-tools/tool-context.js";

/** A file-policy refusal the model sees as `permission_denied`; a deleted Work's file reads as gone. */
export type PermissionDenial = FileAccessDenied & {
  reason: Exclude<FileAccessDenial, "not_found" | "work_deleted">;
};

export function isPermissionDenial(denial: FileAccessDenied): denial is PermissionDenial {
  return denial.reason !== "not_found" && denial.reason !== "work_deleted";
}

const UPLOADS_READ_ONLY_MESSAGE = "Files in uploads:// are read-only, so this change wasn't made.";

/** A place whose AI access is deny: it reads, and a write is not retried. */
const AI_ACCESS_DENIED_MESSAGE =
  "This place is set to deny AI changes, so this change wasn't made. You can read it.";

const CHAT_FROZEN_MESSAGE =
  "The chat that owns these drafts is in the trash, so they are frozen and this change wasn't made.";

/** Matches the read agent's permission line. */
const AGENT_READ_ONLY_MESSAGE = "Your permission is read, so you can change only scratch://.";

/** A read agent's own scratch is always writable, so a refused scratch file is another Work's. */
const AGENT_READ_ONLY_OTHER_SCRATCH_MESSAGE =
  "Your permission is read, so you can change only this chat's scratch://, not another Work's.";

/**
 * A call on a file that was removed, saying who removed it and how. Status and words are
 * agent-edit's (`removedFile`), which its own receipts and refusals share.
 */
export function removedFileResult(
  command: DocumentCommandName,
  removal: DocumentRemovalRecord,
  path?: string,
): WriteToolErrorOutput {
  const { status, message } = removedFile(removal);
  return {
    isError: true,
    output: modelResult({ command, status, payload: { ...(path ? { path } : {}), message } }),
  };
}

/** What the model reads when the policy refused a write. */
export function permissionDeniedMessage(denial: PermissionDenial): string {
  switch (denial.reason) {
    case "work_archived":
      return workArchivedMessage(denial);
    case "chat_frozen":
      return CHAT_FROZEN_MESSAGE;
    case "uploads_read_only":
      return UPLOADS_READ_ONLY_MESSAGE;
    case "ai_access_denied":
      return AI_ACCESS_DENIED_MESSAGE;
    case "agent_read_only":
      return denial.facts?.scheme === "scratch"
        ? AGENT_READ_ONLY_OTHER_SCRATCH_MESSAGE
        : AGENT_READ_ONLY_MESSAGE;
  }
}

/**
 * An archived Work's own files are read-only; a draft-mode chat's write
 * that would land in this Work's drafts meets frozen drafts.
 */
function workArchivedMessage(denial: FileAccessDenied): string {
  const handle = denial.archivedWork?.handle ?? null;
  const work = handle === null ? "This chat's Work" : `Work ${handle}`;
  return denial.destination?.kind === "draft"
    ? `${work} is archived, so its drafts are frozen and this change wasn't made.`
    : `${work} is archived and read-only.`;
}
