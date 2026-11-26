import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import { type DraftId, parseDraftItemKey } from "@meridian/contracts";
import type { PressAction, PressRequest, PressScope } from "@meridian/contracts/drafts";
import { apiProjectPath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import type { PressRooms } from "@/core/editor/document-session-registry";
import { projectQueryKeys } from "./project-query-keys";
import { refreshDraftReads } from "./useOwnerDrafts";
import { whenRead } from "./when-read";
import { refreshWorksSnapshotSince } from "./works-projection-acquisition";

export const PRESS_KIND = "press";
export const PRESS_UNDO_KIND = "unpress";

export type PressBody = { projectId: string } & (PressRequest extends infer R
  ? R extends PressRequest
    ? Omit<R, "commandId">
    : never
  : never);
export type PressUndoBody = { projectId: string; pressCommandId: string };

export type PressGate = (projectId: string, rooms: PressRooms) => Promise<void>;

/**
 * A press or Undo holds the lane of each draft it presses, so it goes after every earlier press
 * on any of them: a Work's press after a Discard of one of its drafts' chapters, not beside it.
 */
const PRESS_LANE = "press:";

export function pressDrafts(scope: PressScope | PressAction["scope"]): DraftId[] {
  if (scope.kind === "work") return scope.drafts;
  if (scope.kind === "draft" || scope.kind === "turn") return [scope.draft];
  const parsed = parseDraftItemKey(scope.item);
  return parsed ? [parsed.draftId] : [];
}

export function pressRooms(record: CommandRecord): PressRooms {
  const scope = (record.body as Partial<PressBody>).scope;
  const parsed =
    scope && (scope.kind === "change" || scope.kind === "document")
      ? parseDraftItemKey(scope.item)
      : null;
  return {
    drafts: record.lanes.flatMap((lane) =>
      lane.startsWith(PRESS_LANE) ? [lane.slice(PRESS_LANE.length) as DraftId] : [],
    ),
    documents: parsed ? [parsed.documentId] : null,
  };
}

export function pressDomain(client: QueryClient, gate: PressGate): CommandDomain {
  // The driver hands every settled press in the journal to `onSettled` on each load. The tab's
  // own reads of drafts all begin after it opened, so a press settled before then is in them;
  // only the Works the server read for the page may predate it. A turn card follows its chat's
  // waiting drafts (`useDraftDock`).
  const opened = Date.now();
  let bound: CommandDriver | null = null;
  const settled = (record: CommandRecord) => {
    const observed = () => void bound?.observe((each) => each.id === record.id);
    const { projectId } = record.body as PressBody | PressUndoBody;
    const since = record.settledAt ?? Date.now();
    const before = since <= opened;
    // The journal's press holds its rows until every draft list on screen has it
    // (`DraftCommandOwner.followPresses`); a list read before it opened already does.
    const read = whenRead(client, { queryKey: projectQueryKeys.draftsOf(projectId) }, before);
    void Promise.all([
      before
        ? refreshWorksSnapshotSince(client, projectId, since)
        : refreshDraftReads(client, projectId, new Set([undefined]), since),
      read,
    ]).then(observed);
  };
  const kinds: Record<string, CommandKind> = {
    [PRESS_KIND]: {
      version: 3,
      migrate: () => {
        throw new Error("A press from an older build");
      },
      request: ({ body }) => {
        const { projectId, ...request } = body as PressBody;
        return { method: "POST", path: `${apiProjectPath(projectId)}/press`, body: request };
      },
      ready: (record) => gate((record.body as PressBody).projectId, pressRooms(record)),
      onSettled: settled,
    },
    [PRESS_UNDO_KIND]: {
      version: 1,
      migrate: (body) => body as PressUndoBody,
      request: ({ body }) => {
        const { projectId, pressCommandId } = body as PressUndoBody;
        return {
          method: "POST",
          path: `${apiProjectPath(projectId)}/press/undo`,
          body: { pressCommandId },
        };
      },
      ready: (record) => gate((record.body as PressUndoBody).projectId, pressRooms(record)),
      onSettled: settled,
    },
  };
  return {
    kinds,
    bind: (driver) => {
      bound = driver;
      return () => {
        if (bound === driver) bound = null;
      };
    },
  };
}

export function submitPress(driver: CommandDriver, body: PressBody) {
  return submitCommand(driver, {
    kind: PRESS_KIND,
    lanes: pressDrafts(body.scope).map((draft) => `${PRESS_LANE}${draft}`),
    body,
  });
}

export function submitPressUndo(
  driver: CommandDriver,
  drafts: readonly string[],
  body: PressUndoBody,
) {
  return submitCommand(driver, {
    kind: PRESS_UNDO_KIND,
    lanes: drafts.map((draft) => `${PRESS_LANE}${draft}`),
    body,
  });
}
