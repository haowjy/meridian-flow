/**
 * The press: Apply or Discard on documents, folders or a whole Work, and its Undo,
 * as commands the driver delivers (resent under one id until the server stores an answer). The
 * server runs both halves; an open document's text changes when its update arrives on the socket.
 */
import type { CommandDriver, CommandKind } from "@meridian/command-driver";
import type { PressRequest, PressResult, PressUndoResult } from "@meridian/contracts/branches";
import { apiProjectPath } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import type { CommandDomain } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import type { RestoreAnswer, RestoredHalves } from "@/features/draft-review/discard-restores";
import { projectQueryKeys } from "./project-query-keys";

export const PRESS_KIND = "press";
export const PRESS_UNDO_KIND = "unpress";

export type PressBody = { projectId: string } & Omit<PressRequest, "commandId">;
export type PressUndoBody = { projectId: string; pressCommandId: string };

/** One Work's presses and Undos go in the order the writer made them. */
const pressLane = (owner: string) => `press:${owner}`;

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
  return submitCommand(driver, { kind: PRESS_KIND, lanes: [pressLane(body.owner)], body });
}

/** `owner` orders the Undo after the press it names. */
export function submitPressUndo(driver: CommandDriver, owner: string, body: PressUndoBody) {
  return submitCommand(driver, { kind: PRESS_UNDO_KIND, lanes: [pressLane(owner)], body });
}

/** What a press settled on: the server's answer, or null when it never landed. */
async function settledResult<T>(
  driver: CommandDriver,
  record: Awaited<ReturnType<typeof submitCommand>>,
): Promise<T | null> {
  if (!record) return null;
  const settled = await driver.whenSettled(record.id);
  return settled?.state === "done" && settled.outcome?.status === "done"
    ? (settled.outcome.result as T)
    : null;
}

/**
 * Trash's Restore of a press Discard: the press's Undo. `gone` when it brought nothing back (an
 * Undo sent elsewhere took it first, or a closed owner's).
 */
export async function restorePressDiscard(
  driver: CommandDriver,
  input: { projectId: string; owner: string; pressCommandId: string },
): Promise<RestoreAnswer> {
  const { owner, ...body } = input;
  const result = await settledResult<PressUndoResult>(
    driver,
    await submitPressUndo(driver, owner, body),
  );
  if (!result) return { answer: "failed" };
  return result.text.length || result.tree.length
    ? { answer: "ok", brought: { text: result.text, tree: result.tree } }
    : { answer: "gone" };
}

/** The Undo of a restore made in Trash: the same documents discarded again, as a new entry. */
export async function rediscard(
  driver: CommandDriver,
  input: { projectId: string; owner: string; brought: RestoredHalves },
): Promise<boolean> {
  const { text, tree } = input.brought;
  const items = [...new Set([...text, ...tree])].map((node) =>
    text.includes(node) ? { node } : { node, half: "tree" as const },
  );
  const record = await submitPress(driver, {
    projectId: input.projectId,
    owner: input.owner,
    verdict: "discard",
    items,
  });
  return (await settledResult<PressResult>(driver, record)) !== null;
}
