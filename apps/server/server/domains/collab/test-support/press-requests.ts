/** The writer's press, driven through the store with the envelope the route would build. */
import { randomUUID } from "node:crypto";
import {
  type CommandId,
  type DraftOwner,
  draftOwnerKey,
  type ProjectId,
  type UserId,
  type WorkId,
} from "@meridian/contracts";
import type { PressRequest } from "@meridian/contracts/branches";
import { type CommandEnvelope, commandDigest } from "../../../shared/commands/command-record.js";
import type { PressStore } from "../adapters/drizzle-press.js";
import { PROJECT_ID, USER_ID, WORK_ID } from "./collab-postgres-harness.js";

function pressEnvelope(kind: "press" | "unpress", accountId: UserId, body: unknown) {
  const envelope: CommandEnvelope = {
    commandId: randomUUID() as CommandId,
    accountId,
    projectId: PROJECT_ID as ProjectId,
    kind,
    digest: commandDigest({ accountId, projectId: PROJECT_ID, kind, selectors: {}, body }),
  };
  return envelope;
}

export function pressDriver(
  presses: PressStore,
  scope: { owner?: DraftOwner; userId?: UserId } = {},
) {
  const owner = scope.owner ?? { kind: "work", workId: WORK_ID as WorkId };
  const userId = scope.userId ?? (USER_ID as UserId);
  const press = (verdict: PressRequest["verdict"], items: PressRequest["items"]) => {
    const request = { owner: draftOwnerKey(owner), verdict, items };
    const envelope = pressEnvelope("press", userId, request);
    return presses.press({
      envelope,
      owner,
      request: { ...request, commandId: envelope.commandId },
    });
  };
  return {
    apply: (documentId: string) => press("apply", [{ node: documentId }]),
    discard: (documentId: string) => press("discard", [{ node: documentId }]),
    discardAll: () => press("discard", "all"),
    undo: (pressCommandId: CommandId) =>
      presses.undo({
        envelope: pressEnvelope("unpress", userId, { pressCommandId }),
        pressCommandId,
      }),
  };
}
