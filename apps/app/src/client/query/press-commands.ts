/**
 * The press: Apply or Discard on documents, folders or a whole Work, and its Undo,
 * as commands the driver delivers (resent under one id until the server stores an answer). The
 * server runs both halves; an open document's text changes when its update arrives on the socket.
 */
import type { CommandDriver, CommandKind, CommandRecord } from "@meridian/command-driver";
import type { PressRequest, PressResult, PressUndoResult } from "@meridian/contracts/drafts";
import { apiProjectPath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import { refreshDraftReads } from "./useOwnerDrafts";
import { refreshTurnCards } from "./useTurnLiveLineage";

export const PRESS_KIND = "press";
export const PRESS_UNDO_KIND = "unpress";

export type PressBody = { projectId: string } & Omit<PressRequest, "commandId">;
export type PressUndoBody = { projectId: string; pressCommandId: string };

/** What a settled press or Undo changed; nothing when it failed. */
function nodesOf(record: CommandRecord): string[] {
  if (record.outcome?.status !== "done") return [];
  const result = record.outcome.result as PressResult | PressUndoResult;
  return result.status === "pressed"
    ? result.items.map((item) => item.node)
    : [...result.text, ...result.tree];
}

/** One Work's presses and Undos go in the order the writer made them. */
const pressLane = (draft: string) => `press:${draft}`;

export function pressDomain(client: QueryClient): CommandDomain {
  // The driver hands every settled press in the journal to `onSettled` on each load; one settled
  // before this tab opened is in every read the tab makes, so it needs none of its own.
  const opened = Date.now();
  let bound: CommandDriver | null = null;
  const settled = (record: CommandRecord) => {
    const observed = () => void bound?.observe((each) => each.id === record.id);
    if ((record.settledAt ?? 0) <= opened) return observed();
    // A press can change any draft's list (two Works on one passage: the first applied wins), and
    // what became of the turns that drafted its documents.
    const { projectId } = record.body as PressBody | PressUndoBody;
    void Promise.allSettled([
      refreshDraftReads(client, projectId, new Set([undefined])),
      ...nodesOf(record).map((node) => refreshTurnCards(client, node)),
    ]).then(observed);
  };
  const kinds: Record<string, CommandKind> = {
    [PRESS_KIND]: {
      version: 1,
      migrate: (body) => body as PressBody,
      request: ({ body }) => {
        const { projectId, ...request } = body as PressBody;
        return { method: "POST", path: `${apiProjectPath(projectId)}/press`, body: request };
      },
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
  return submitCommand(driver, { kind: PRESS_KIND, lanes: [pressLane(body.draft)], body });
}

/** `draft` orders the Undo after the press it names. */
export function submitPressUndo(driver: CommandDriver, draft: string, body: PressUndoBody) {
  return submitCommand(driver, { kind: PRESS_UNDO_KIND, lanes: [pressLane(draft)], body });
}
