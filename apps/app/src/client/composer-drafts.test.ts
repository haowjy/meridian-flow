// @vitest-environment jsdom
/** A hand-back's content reaches the composer exactly once, across reloads. */

import { chatReferenceResolver, composerDocFromHandedBack } from "@meridian/thread-client";
import { expect, it } from "vitest";
import { ComposerSessionDraft, type PendingHandBack } from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";

const command: PendingHandBack = {
  kind: "stop",
  requestId: "request-1",
  occurrence: { requestId: "request-1", attempt: 1 },
  body: { requestId: "request-1", seenThrough: 4, seenExecutionId: null, mine: [] },
};
const queueCommand: PendingHandBack = {
  kind: "queue",
  requestId: "request-q",
  ids: ["m1", "m2"],
  occurrence: { requestId: "request-q", attempt: 1 },
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const resolve = chatReferenceResolver({
  projectId: uuid(1),
  userId: uuid(2),
  work: { id: uuid(3), handle: null },
  rootThreadId: uuid(4),
  rootThreadRef: "c1",
} as never);
const returned = composerDocFromHandedBack(
  [
    {
      userTurnId: "m1",
      blocks: [
        { type: "text", text: "Steer first " },
        {
          type: "reference",
          text: "[notes](scratch://@c1/notes.md)",
          documentId: uuid(5),
          uri: "scratch://@c1/notes.md",
        },
      ],
    },
    { userTurnId: "m2", blocks: [{ type: "text", text: "Steer second" }] },
  ] as never,
  resolve,
);
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
  // A queue command (the x / Cancel queue) waits beside Stop and survives a reload in its own shape.
  expect(draft.recordHandBack(queueCommand)).toBe(true);

  // Reloaded between the press and the answer: the command is still there to re-post.
  const afterPress = reload(account);
  expect(afterPress.handBacks).toEqual([command, queueCommand]);
  expect(afterPress.hasReceivedHandBack("request-1")).toBe(false);

  // The original answer and the re-posted one both arrive in this tab.
  expect(afterPress.receiveHandBack("request-1", returned)).toBe(true);
  expect(afterPress.receiveHandBack("request-1", returned)).toBe(true);
  const merged = "Steer first [notes](scratch://@c1/notes.md)\n\nSteer second\n\nTyped since";
  expect(typed(afterPress)).toBe(merged);
  expect(afterPress.handBacks).toEqual([queueCommand]);

  // Reloaded after the write, before the intent retired: nothing is posted or prepended again.
  const afterWrite = reload(account);
  expect(afterWrite.handBacks).toEqual([queueCommand]);
  expect(afterWrite.hasReceivedHandBack("request-1")).toBe(true);
  expect(afterWrite.receiveHandBack("request-1", returned)).toBe(true);
  // The reference chip and the typed words both survive the reload.
  expect(typed(afterWrite)).toBe(merged);

  // A returned document that wouldn't restore after a reload leaves its command in place
  // (risk: retiring a command into a draft the next load throws away).
  const second = { ...command, requestId: "request-2" };
  expect(afterWrite.recordHandBack(second)).toBe(true);
  const broken = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "composerReference", attrs: { reference: { documentId: uuid(5) } } }],
      },
    ],
  };
  expect(afterWrite.receiveHandBack("request-2", broken)).toBe(false);
  expect(afterWrite.handBacks).toEqual([queueCommand, second]);
  expect(afterWrite.hasReceivedHandBack("request-2")).toBe(false);
});
