/**
 * Model-facing copy for file-policy refusals (file-access §9, D31, D53, D54).
 * A refusal that suggests a call writes it exactly, and only when the agent
 * may make it; otherwise it says to ask the user.
 */
import type { DocumentRemovalRecord, FileAccessDenial } from "@meridian/contracts/protocol";
import { removalPhrase } from "../domains/context/index.js";
import type { FileAccessDenied } from "../domains/file-policy/index.js";
import { chainPermission, mayChangeWorks } from "../domains/runtime/index.js";

/** A file-policy refusal the model sees as `permission_denied`. */
export type PermissionDenial = FileAccessDenied & {
  reason: Exclude<FileAccessDenial, "not_found">;
};

export function isPermissionDenial(denial: FileAccessDenied): denial is PermissionDenial {
  return denial.reason !== "not_found";
}

const UPLOADS_READ_ONLY_MESSAGE = "Files in uploads:// are read-only, so this change wasn't made.";

/** Matches the read agent's permission line (D54). */
const AGENT_READ_ONLY_MESSAGE = "Your permission is read, so you can change only scratch://.";

/** A read agent's own scratch is always writable, so a refused scratch file is another Work's. */
const AGENT_READ_ONLY_OTHER_SCRATCH_MESSAGE =
  "Your permission is read, so you can change only this chat's scratch://, not another Work's.";

/**
 * A write whose file was removed under it: at the reply's save (D29, D42), or when an undo
 * or redo reached it. The record, when the lookup found one, says who removed it and how.
 */
export function deletedFileMessage(
  when: "save" | "reversal",
  removal?: DocumentRemovalRecord | null,
): string {
  const removed = `This file was ${removalPhrase(removal)}`;
  return when === "save" && removal?.actor?.kind !== "system"
    ? `${removed} before this reply was saved, so this change wasn't made.`
    : `${removed}, so this change wasn't made.`;
}

/** What the model reads when the policy refused a write. */
export function permissionDeniedMessage(denial: PermissionDenial): string {
  switch (denial.reason) {
    case "work_archived":
      return workArchivedMessage(denial);
    case "uploads_read_only":
      return UPLOADS_READ_ONLY_MESSAGE;
    case "agent_read_only":
      return denial.facts?.scheme === "scratch"
        ? AGENT_READ_ONLY_OTHER_SCRATCH_MESSAGE
        : AGENT_READ_ONLY_MESSAGE;
  }
}

/**
 * An archived Work's own files are read-only (D29); a draft-mode chat's write
 * that would land in this Work's drafts meets frozen drafts (D30, D31), and switching
 * the chat to auto-apply is the writer's way out (D62). Only an agent the
 * action policy lets unarchive is offered the call.
 */
function workArchivedMessage(denial: FileAccessDenied): string {
  const slug = denial.archivedWork?.slug ?? null;
  const work = slug === null ? "This chat's Work" : `Work @${slug}`;
  const named = slug === null ? "it" : `@${slug}`;
  const unarchive = slug === null ? null : `\`work({"command":"unarchive","work":"${slug}"})\``;
  const mayUnarchive =
    unarchive !== null &&
    denial.agentChain !== null &&
    mayChangeWorks(chainPermission(denial.agentChain));
  if (denial.destination?.kind === "draft") {
    const frozen = `${work} is archived, so its drafts are frozen and this change wasn't made.`;
    return mayUnarchive
      ? `${frozen} Unarchive it with ${unarchive}, or ask the user to switch this chat to auto-apply.`
      : `${frozen} Ask the user to unarchive ${named} or switch this chat to auto-apply.`;
  }
  return mayUnarchive
    ? `${work} is archived and read-only. Unarchive it with ${unarchive} before changing its files.`
    : `${work} is archived and read-only. Ask the user to unarchive ${named}.`;
}
