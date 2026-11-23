/** The writer's press, driven through the store with the envelope the route would build. */
import { randomUUID } from "node:crypto";
import type { CommandId, DraftId, ProjectId, UserId } from "@meridian/contracts";
import type { TreePressRequest } from "@meridian/contracts/drafts";
import { type CommandEnvelope, commandDigest } from "../../../shared/commands/command-record.js";
import type { PressStore } from "../adapters/drizzle-press.js";
import { PROJECT_ID, USER_ID, WORK_DRAFT_ID } from "./collab-postgres-harness.js";

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

export function pressDriver(presses: PressStore, scope: { draft?: DraftId; userId?: UserId } = {}) {
  const draft = scope.draft ?? WORK_DRAFT_ID;
  const userId = scope.userId ?? (USER_ID as UserId);
  const press = (verdict: TreePressRequest["verdict"], items: TreePressRequest["items"]) => {
    const request = { draft, verdict, items };
    const envelope = pressEnvelope("press", userId, request);
    return presses.press({ envelope, request: { ...request, commandId: envelope.commandId } });
  };
  return {
    apply: (documentId: string) => press("apply", [{ node: documentId }]),
    discard: (documentId: string) => press("discard", [{ node: documentId }]),
    undo: (pressCommandId: CommandId) =>
      presses.undo({
        envelope: pressEnvelope("unpress", userId, { pressCommandId }),
        pressCommandId,
      }),
  };
}
