import {
  type DocumentCommandName,
  modelResult,
  removedFile,
} from "@meridian/agent-edit/integration";
import type { DocumentRemovalRecord, FileAccessDenial } from "@meridian/contracts/protocol";
import type { FileAccessDenied } from "../domains/file-policy/index.js";
import type { WriteToolErrorOutput } from "./model-tools/tool-context.js";

export type PermissionDenial = FileAccessDenied & {
  reason: Exclude<FileAccessDenial, "not_found" | "work_deleted">;
};

export function isPermissionDenial(denial: FileAccessDenied): denial is PermissionDenial {
  return denial.reason !== "not_found" && denial.reason !== "work_deleted";
}

const UPLOADS_READ_ONLY_MESSAGE = "Files in uploads:// are read-only, so this change wasn't made.";

const AI_ACCESS_DENIED_MESSAGE =
  "This place is set to deny AI changes, so this change wasn't made. You can read it.";

const CHAT_FROZEN_MESSAGE =
  "The chat that owns these drafts is in the trash, so they are frozen and this change wasn't made.";

const AGENT_READ_ONLY_MESSAGE = "Your permission is read, so you can change only scratch://.";

const AGENT_READ_ONLY_OTHER_SCRATCH_MESSAGE =
  "Your permission is read, so you can change only this chat's scratch://, not another Work's.";

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

function workArchivedMessage(denial: FileAccessDenied): string {
  const handle = denial.archivedWork?.handle ?? null;
  const work = handle === null ? "This chat's Work" : `Work ${handle}`;
  return denial.destination?.kind === "draft"
    ? `${work} is archived, so its drafts are frozen and this change wasn't made.`
    : `${work} is archived and read-only.`;
}
