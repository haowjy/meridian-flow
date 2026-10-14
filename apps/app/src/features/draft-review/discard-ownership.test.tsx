// @vitest-environment jsdom
/**
 * Who owns a Discard. A text draft's Discard is an undoable edit: with no editor to own it, it never closes the
 * item on the server. Headless Discard state lives for one Work beneath the persistent chat: rebinding the same
 * chat to another Work retires its rows and Undo authority and fences a Discard still pending in the old Work.
 */
import { act } from "react";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DocumentSession } from "@/core/editor/document-session";
import { projectRoom } from "@/features/draft-review/review-frame";
import { reviewChanges } from "@/features/draft-review/review-model";
import { retainReviewRuntime, reviewRuntimeOf } from "@/features/draft-review/review-runtime";
import { useHeadlessDiscards } from "@/features/draft-review/useHeadlessDiscards";
import { useBoundWorkDraftCommands } from "@/features/draft-review/useWorkDraftCommands";
import { MobileDocumentReview } from "@/features/project/mobile/MobileDocumentReview";
import {
  createReviewScopeFixture,
  draftA,
  listed,
  meta,
  workC,
} from "@/test-support/draft-review-scope";
import { seedReviewBase } from "@/test-support/inline-review-editor";
import { settleReact } from "@/test-support/react-dom-harness";

// Opening another draft is navigation; this suite owns what a Discard binds to.
vi.mock("@/features/project/dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openReviewFile: () => {} }),
}));

it("a text Discard without an editor never closes the item, and a same-chat Work rebind retires the old Work's Discard rows, Undo and pending completions", async () => {
  vi.useFakeTimers();
  const fixture = createReviewScopeFixture();
  const room = new DocumentSession({ roomKey: "r", persistence: { kind: "none" } });
  room.whenSynced = () => Promise.resolve();
  fixture.rooms.set("r", room);
  const fragment = room.document.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, "Door green.");
  fragment.insert(0, [paragraph]);
  seedReviewBase(room.document, ["Door red."]);
  let discards!: ReturnType<typeof useHeadlessDiscards>;
  let scope = "";
  let answerMeta!: (meta: never) => void;
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [listed] });
  fixture.network.getDraftMeta.mockResolvedValueOnce(meta as never);
  fixture.network.getDraftMeta.mockReturnValue(new Promise((resolve) => (answerMeta = resolve)));
  function Probe() {
    const commands = useBoundWorkDraftCommands();
    scope = commands.workId;
    discards = useHeadlessDiscards(commands.projectId, commands.workId);
    return null;
  }
  const file = { documentId: listed.documentId, draft: listed } as never;
  try {
    await fixture.render(
      async (read) => {
        expect(scope).toBe("work-a");
        const controller = () => read().presented.controller;
        await act(async () => controller().enterInlineReview(draftA.documentId, draftA.itemKey));
        await settleReact(() => expect(read().presented.roomOwner.roomName).toBe(meta.roomName));
        expect(controller().wholeItem).toBe(false);
        await act(async () => {
          const outcome = await controller().discard(draftA.documentId, draftA.itemKey);
          expect(outcome).toEqual({ kind: "blocked" });
        });
        expect(fixture.network.discardDraft).not.toHaveBeenCalled();

        const change = reviewChanges(projectRoom(room.document))[0];
        await act(async () => discards.discardChange(file, change, 0, "r"));
        await act(async () => discards.discardFile(file, "thread"));
        expect(discards.entries).toHaveLength(2);

        await read().moveChatToWork(workC);
        expect(scope).toBe("work-c");
        expect(discards.entries).toEqual([]);
        // The old Work's pending Discard completes late: nothing reaches the new Work's rows.
        await act(async () => answerMeta({ kind: "text", roomName: "r" } as never));
        expect(discards.entries).toEqual([]);
        // Nothing of the old Work can be undone any more: its text stays discarded.
        expect(fragment.toString()).toContain("red");
      },
      { chatSurface: <Probe /> },
    );
  } finally {
    fixture.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("a phone Discard binds to its open review: with the document absent from the Work list, Discard, Undo, Discard again still leaves its own Undo row", async () => {
  const fixture = createReviewScopeFixture();
  const room = new DocumentSession({ roomKey: meta.roomName, persistence: { kind: "none" } });
  room.whenSynced = () => Promise.resolve();
  fixture.rooms.set(meta.roomName, room);
  const fragment = room.document.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, "Door green.");
  fragment.insert(0, [paragraph]);
  seedReviewBase(room.document, ["Door red."]);
  // The Work lists no draft for this document: the open review alone names what a Discard acts on.
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [] });
  fixture.network.getDraftMeta.mockResolvedValue(meta as never);
  const tab = {
    kind: "tracked",
    documentId: draftA.documentId,
    scheme: "manuscript",
    path: "/door.md",
    name: "door.md",
    editable: true,
    filetype: "markdown",
  } as never;
  let releaseRuntime: (() => void) | undefined;
  const rows = () => document.querySelectorAll("[data-phone-discarded] li").length;
  const click = (label: RegExp) =>
    act(async () => {
      const button = [...document.querySelectorAll("button")].find((b) =>
        label.test(b.textContent ?? ""),
      );
      if (!button) throw new Error(`No button ${label}`);
      button.click();
    });
  try {
    await fixture.render(
      async (read) => {
        await act(async () =>
          read().presented.controller.enterInlineReview(draftA.documentId, draftA.itemKey),
        );
        await act(async () =>
          read().presented.controller.setInlineReviewShown(draftA.documentId, draftA.itemKey, true),
        );
        await settleReact(() => expect(read().presented.roomOwner.roomName).toBe(meta.roomName));
        // The editor retains the review's runtime while it paints; this fixture has none, so it does.
        const draft = { projectId: "project-a", workId: "work-a", ...draftA };
        const release = retainReviewRuntime(draft, room, read().queryClient);
        releaseRuntime = release;
        reviewRuntimeOf(draft)?.projectNow();
        const [change] = reviewChanges(projectRoom(room.document));
        await act(async () =>
          read().presented.controller.focusReviewChange(draftA, change.id, { scroll: false }),
        );
        await settleReact(() =>
          expect(document.querySelector("[data-phone-change-bar]")).not.toBeNull(),
        );
        await click(/^Discard$/);
        expect(rows()).toBe(1);
        expect(fragment.toString()).toContain("red");
        await click(/^Undo$/);
        expect(rows()).toBe(0);
        expect(fragment.toString()).toContain("green");
        await click(/^Discard$/);
        expect(rows()).toBe(1);
        expect(fragment.toString()).toContain("red");
      },
      {
        surface: (
          <MobileDocumentReview projectId="project-a" tab={tab}>
            {null}
          </MobileDocumentReview>
        ),
      },
    );
  } finally {
    releaseRuntime?.();
    fixture.dispose();
    vi.restoreAllMocks();
  }
});
