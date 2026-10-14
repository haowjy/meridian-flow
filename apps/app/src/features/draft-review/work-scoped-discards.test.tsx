// @vitest-environment jsdom
/**
 * Headless Discard state lives for one Work beneath the persistent chat: rebinding the same chat to another
 * Work retires its rows and Undo authority and fences a Discard still pending in the old Work.
 */
import { act } from "react";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DocumentSession } from "@/core/editor/document-session";
import { projectRoom } from "@/features/draft-review/review-frame";
import { reviewChanges } from "@/features/draft-review/review-model";
import { useHeadlessDiscards } from "@/features/draft-review/useHeadlessDiscards";
import { useBoundWorkDraftCommands } from "@/features/draft-review/useWorkDraftCommands";
import { createReviewScopeFixture, listed, workC } from "@/test-support/draft-review-scope";
import { seedReviewBase } from "@/test-support/inline-review-editor";

it("a same-chat Work rebind retires the old Work's Discard rows, Undo and pending completions", async () => {
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
