// @vitest-environment jsdom
/** A hand-back's content reaches the composer exactly once, across reloads. */

import { composerDocFromHandedBack } from "@meridian/thread-client";
import { expect, it } from "vitest";
import { ComposerSessionDraft, type PendingHandBack } from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";

const command: PendingHandBack = {
  kind: "stop",
  requestId: "request-1",
  body: { requestId: "request-1", seenThrough: 4, seenExecutionId: null, mine: [] },
};
const returned = composerDocFromHandedBack([
  { userTurnId: "m1", blocks: [{ type: "text", text: "Steer first" }] },
  { userTurnId: "m2", blocks: [{ type: "text", text: "Steer second" }] },
]);
const reload = (account: string) => new ComposerSessionDraft(account, { kind: "chat", id: "t" });
const typed = (draft: ComposerSessionDraft) =>
  draft.initialDraft ? serializeComposerDraft(draft.initialDraft.doc).text : null;

it("prepends a hand-back once, whether the tab reloads before the answer or after its write", () => {
  const account = "account-hand-back";
  const draft = reload(account);
  const snapshot = serializeComposerDraft(plainComposerDoc("Typed since")).draft;
  draft.updateDraft({ text: "Typed since", snapshot });
  draft.flush();
  expect(draft.recordHandBack(command)).toBe(true);

  // Reloaded between the press and the answer: the command is still there to re-post.
  const afterPress = reload(account);
  expect(afterPress.handBacks).toEqual([command]);
  expect(afterPress.hasReceivedHandBack("request-1")).toBe(false);

  // The original answer and the re-posted one both arrive in this tab.
  expect(afterPress.receiveHandBack("request-1", returned)).toBe(true);
  expect(afterPress.receiveHandBack("request-1", returned)).toBe(true);
  expect(typed(afterPress)).toBe("Steer first\n\nSteer second\n\nTyped since");
  expect(afterPress.handBacks).toEqual([]);

  // Reloaded after the write, before the intent retired: nothing is posted or prepended again.
  const afterWrite = reload(account);
  expect(afterWrite.handBacks).toEqual([]);
  expect(afterWrite.hasReceivedHandBack("request-1")).toBe(true);
  expect(afterWrite.receiveHandBack("request-1", returned)).toBe(true);
  expect(typed(afterWrite)).toBe("Steer first\n\nSteer second\n\nTyped since");
});
