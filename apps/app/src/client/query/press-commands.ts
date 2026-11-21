/**
 * The press: Apply or Discard on documents, folders or a whole Work, and its Undo,
 * as commands the driver delivers (resent under one id until the server stores an answer). The
 * server runs both halves; an open document's text changes when its update arrives on the socket.
 */
import type { CommandDriver, CommandKind } from "@meridian/command-driver";
import type { PressRequest } from "@meridian/contracts/drafts";
import { apiProjectPath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import { projectQueryKeys } from "./project-query-keys";

export const PRESS_KIND = "press";
export const PRESS_UNDO_KIND = "unpress";

export type PressBody = { projectId: string } & Omit<PressRequest, "commandId">;
export type PressUndoBody = { projectId: string; pressCommandId: string };

/** One Work's presses and Undos go in the order the writer made them. */
const pressLane = (draft: string) => `press:${draft}`;

export function pressDomain(client: QueryClient): CommandDomain {
  // The Changes list and the counts read the server: a settled press shows there on the next read.
  const refresh = (projectId: string) =>
    void client.invalidateQueries({ queryKey: [...projectQueryKeys.all, projectId] });
  let bound: CommandDriver | null = null;
  const observed = (id: string) => void bound?.observe((record) => record.id === id);
  const kinds: Record<string, CommandKind> = {
    [PRESS_KIND]: {
      version: 1,
      migrate: (body) => body as PressBody,
      request: ({ body }) => {
        const { projectId, ...request } = body as PressBody;
        return { method: "POST", path: `${apiProjectPath(projectId)}/press`, body: request };
      },
      onSettled: (record) => {
        refresh((record.body as PressBody).projectId);
        observed(record.id);
      },
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
      onSettled: (record) => {
        refresh((record.body as PressUndoBody).projectId);
        observed(record.id);
      },
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
