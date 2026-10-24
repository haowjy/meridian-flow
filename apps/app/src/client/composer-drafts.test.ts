// @vitest-environment jsdom
/** Durability guards for handing returned content back to the composer. */

import { expect, it } from "vitest";
import { ComposerSessionDraft, type PendingHandBack } from "@/client/composer-drafts";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("keeps a hand-back pending when its returned document cannot survive reload", () => {
  const command: PendingHandBack = {
    kind: "stop",
    requestId: "request-1",
    occurrence: { requestId: "request-1", attempt: 1 },
    body: { requestId: "request-1", seenThrough: 4, seenExecutionId: null, mine: [] },
  };
  const draft = new ComposerSessionDraft("account-hand-back", { kind: "chat", id: "t" });
  const original = serializeComposerDraft(plainComposerDoc("Typed since"));
  draft.updateDraft({ text: original.text, snapshot: original.draft });
  draft.flush();
  expect(draft.recordHandBack(command)).toBe(true);

  const broken = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "composerReference", attrs: { reference: { documentId: uuid(5) } } }],
      },
    ],
  };
  expect(draft.receiveHandBack("request-1", broken)).toBe(false);
  expect(draft.handBacks).toEqual([command]);
  expect(draft.hasReceivedHandBack("request-1")).toBe(false);
  expect(serializeComposerDraft(draft.initialDraft?.doc ?? plainComposerDoc("")).text).toBe(
    "Typed since",
  );
});
