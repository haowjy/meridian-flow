/**
 * A permission request's words, from the facts the server stores: the sentence that asks,
 * and for an update that sets several fields, one line per field.
 */
import { t } from "@lingui/core/macro";
import type { PermissionAskPayload } from "@meridian/contracts/threads";
import { DEFAULT_AGENT_NAME } from "@/features/agents/constants";

export function permissionRequestText(payload: PermissionAskPayload): {
  title: string;
  details: string[];
} {
  const agent = payload.agent ?? DEFAULT_AGENT_NAME;
  const work = payload.work
    ? payload.work.handle
      ? `${payload.work.name} (@${payload.work.handle})`
      : t`No Work`
    : "";
  const { name, goal, status, mode } = payload.changes;
  switch (payload.action) {
    case "work.create": {
      const created = name ?? "";
      return { title: t`${agent} wants to create the Work “${created}”?`, details: [] };
    }
    case "work.archive":
      return { title: t`${agent} wants to archive ${work}?`, details: [] };
    case "work.unarchive":
      return { title: t`${agent} wants to unarchive ${work}?`, details: [] };
    case "work.delete":
      return { title: t`${agent} wants to delete ${work}?`, details: [] };
    case "work.switch":
      return { title: t`${agent} wants to move this chat to ${work}?`, details: [] };
    case "work.write_mode":
      return {
        title:
          mode === "draft"
            ? t`${agent} wants to switch this chat to draft mode?`
            : t`${agent} wants to switch this chat to auto-apply?`,
        details: [],
      };
    case "work.update": {
      const details = [
        name !== undefined ? t`Rename to “${name}”` : null,
        goal !== undefined ? (goal ? t`Set the goal to “${goal}”` : t`Clear the goal`) : null,
        status !== undefined
          ? status
            ? t`Set the status to “${status}”`
            : t`Clear the status`
          : null,
      ].filter((line): line is string => line !== null);
      // One change reads as one sentence; several list under the request.
      if (details.length === 1 && name !== undefined)
        return { title: t`${agent} wants to rename ${work} to “${name}”?`, details: [] };
      return { title: t`${agent} wants to update ${work}?`, details };
    }
  }
}
