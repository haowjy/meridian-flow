// @vitest-environment jsdom
/**
 * The draft dock lists the drafts a chat wrote into and reads membership even while collapsed,
 * from that draft's room. Apply sends the group ids with the snapshot of the room they came from; Discard
 * is in place: a prose draft's room is edited and the row reads "Discarded" with Undo, a new document's draft closes.
 */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { REVIEW_BASE_FRAGMENT } from "@meridian/agent-edit/diff";
import type { DraftItemDiscardResult } from "@meridian/contracts/drafts";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import { encodeSnapshot } from "@/features/draft-review/useDraftApply";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { createReviewScopeFixture, listed, meta } from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";
import { DraftDock } from "./DraftDock";
import { useDraftDock } from "./useDraftDock";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const open = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  open.mockClear();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  fixture = createReviewScopeFixture();
  vi.spyOn(projectsApi, "listProjectWorks").mockReturnValue(new Promise(() => {}));
  vi.spyOn(handoff, "useOpenEditorReview").mockReturnValue(open);
});
afterEach(() => {
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const pacing = { threadId: "thread-a", title: "Pacing pass" };
const draft = (id: string, extra: object = {}) => ({
  ...listed,
  documentId: id,
  itemKey: `draft-${id}`,
  documentName: id,
  contextLocation: { scheme: "manuscript" as const, path: `/${id}.md` },
  actorThreads: [pacing],
  ...extra,
});

function roomDoc(id: string) {
  const room = fixture.rooms.get(`room-${id}`);
  if (!room) throw new Error(`No room for ${id}`);
  return room.document;
}

/** Give a draft room text: its draft paragraphs and the base they are measured against. */
function fillRoom(roomName: string, draftText: string[], baseText: string[]) {
  const room = fixture.rooms.get(roomName);
  if (!room) throw new Error(`room ${roomName} was never opened`);
  const write = (name: string, paragraphs: string[]) => {
    const fragment = room.document.getXmlFragment(name);
    for (const text of paragraphs) {
      const paragraph = new Y.XmlElement("paragraph");
      const run = new Y.XmlText();
      paragraph.insert(0, [run]);
      run.insert(0, text);
      fragment.insert(fragment.length, [paragraph]);
    }
  };
  room.document.transact(() => {
    write("prosemirror", draftText);
    write(REVIEW_BASE_FRAGMENT, baseText);
  });
}

function Strip() {
  return <DraftDock dock={useDraftDock({ threadId: "thread-a", generating: false })} />;
}
/** The harness renders into its own window: a desktop one. */
function Desktop({ children }: { children: React.ReactNode }) {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as never;
  return children;
}
const host = (children: React.ReactNode) => (
  <I18nProvider i18n={i18n}>
    <TooltipProvider>
      <ProjectNavigationProvider openContextRoute={vi.fn()} openWork={vi.fn()}>
        <Desktop>{children}</Desktop>
      </ProjectNavigationProvider>
    </TooltipProvider>
  </I18nProvider>
);
const click = (selector: string) =>
  act(async () => document.querySelector<HTMLElement>(selector)?.click());
const clickText = (name: string) =>
  act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === name)
      ?.click();
  });

it("an expanded file lists its room's changes; Apply sends the id with the snapshot of the projection clicked (not a room that moved since) and reports what it overrode, and Discard is in place with Undo on the row", async () => {
  const file = draft("chapter", { itemKey: "draft-a" });
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [file] });
  fixture.network.getThreadDraftFiles.mockResolvedValue({ drafts: [file] });
  // Every item this room's peer wrote is this chat's edit.
  fixture.network.getDraftAttribution.mockImplementation(async (_p, _w, id) => ({
    revision: [...Y.encodeSnapshot(Y.snapshot(roomDoc(id)))],
    itemKey: "draft-a",
    userId: "user-1",
    edits: [
      {
        threadId: "thread-a",
        title: "Chat A",
        turnId: "turn-1",
        owner: {
          threadId: "thread-a",
          title: "Chat A",
          reveal: { threadId: "thread-a", turnId: "turn-1" },
        },
        at: "2026-10-13T10:00:00Z",
        inserted: [[fixture.rooms.get("room-chapter")?.document.clientID ?? 0, 0, 100_000]],
        deleted: [],
      },
    ],
  }));
  fixture.network.getDraftMeta.mockResolvedValue({
    ...meta,
    itemKey: "draft-a",
    roomName: "room-chapter",
  });
  fixture.network.applyDraftChanges.mockResolvedValue({
    status: "applied",
    itemKey: "draft-a",
    itemClosed: false,
    overrode: [{ live: "dawn", applied: "dusk" }],
  } as never);
  await fixture.render(
    async () => {
      await settleReact(() => expect(fixture.rooms.has("room-chapter")).toBe(true));
      await act(async () =>
        fillRoom("room-chapter", ["It was green.", "Fine."], ["It was red.", "Fine."]),
      );
      await settleReact(() => expect(document.querySelector("[data-draft-dock]")).not.toBeNull());
      expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(0);
      await click('[aria-label="Expand changes"]');
      await settleReact(() =>
        expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(1),
      );

      const room = fixture.rooms.get("room-chapter") as NonNullable<
        ReturnType<typeof fixture.rooms.get>
      >;
      const text = () =>
        room.document
          .getXmlFragment("prosemirror")
          .toArray()
          .map((node) => (node as Y.XmlElement).toString().replace(/<[^>]+>/g, ""));

      // Discard removes exactly this change, leaves the writer's later typing, and Undo reverts only it.
      await click('[data-review-change-row] [aria-label="Discard"]');
      // The edit exists the moment "Discarded" shows, and the original row never stands beside it.
      expect(text()).toEqual(["It was red.", "Fine."]);
      expect(document.querySelector("[data-discarded-row]")?.textContent).toContain("Discarded");
      expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(0);
      await act(async () => vi.advanceTimersByTime(200));
      expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(0);
      await act(async () =>
        (
          (room.document.getXmlFragment("prosemirror").get(1) as Y.XmlElement).get(0) as Y.XmlText
        ).insert(5, "!"),
      );
      await clickText("Undo");
      await settleReact(() => expect(text()).toEqual(["It was green.", "Fine.!"]));
      await act(async () =>
        (
          (room.document.getXmlFragment("prosemirror").get(1) as Y.XmlElement).get(0) as Y.XmlText
        ).delete(5, 1),
      );
      await settleReact(() =>
        expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(1),
      );
      expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
      expect(fixture.network.discardDraft).not.toHaveBeenCalled();
      expect(document.querySelector("[data-discarded-row]")).toBeNull();

      // Undo provenance can publish its frame immediately, before the subsequent writer edit's
      // debounce. Wait for that edit's projection, not merely for the already-visible row count.
      await act(async () => vi.advanceTimersByTime(200));
      const id = document.querySelector<HTMLElement>("[data-review-change-row]")?.dataset
        .reviewChangeRow;
      const clicked = encodeSnapshot(Y.snapshot(room.document));
      // A peer writes after the projection the row shows, before the next one is computed.
      await act(async () => fillRoom("room-chapter", ["A peer's paragraph."], []));
      expect(encodeSnapshot(Y.snapshot(room.document))).not.toBe(clicked);

      await click('[data-review-change-row] [aria-label="Apply"]');
      await settleReact(() => expect(fixture.network.applyDraftChanges).toHaveBeenCalledOnce());
      expect(fixture.network.applyDraftChanges.mock.calls[0][3]).toMatchObject({
        itemKey: "draft-a",
        changeIds: [id],
        snapshot: clicked,
      });
      await settleReact(() =>
        expect(document.body.textContent).toContain("Applied over a newer edit in live"),
      );

      // The draft dock's Discard all takes this chat's changes only: another chat's change in the file stays.
      const other = new Y.Doc({ gc: false });
      Y.applyUpdate(other, Y.encodeStateAsUpdate(room.document));
      other.clientID = room.document.clientID + 1;
      const foreign = new Y.XmlElement("paragraph");
      const run = new Y.XmlText();
      foreign.insert(0, [run]);
      run.insert(0, "Another chat's line.");
      other.getXmlFragment("prosemirror").insert(0, [foreign]);
      await act(async () => Y.applyUpdate(room.document, Y.encodeStateAsUpdate(other)));
      await settleReact(() =>
        expect(
          [...document.querySelectorAll<HTMLButtonElement>("button")].some(
            (button) => button.textContent === "Discard" && !button.disabled,
          ),
        ).toBe(true),
      );
      await clickText("Discard");
      await settleReact(() =>
        expect(text()).toEqual(["Another chat's line.", "It was red.", "Fine."]),
      );
    },
    { chatSurface: <Strip />, host },
  );
});

it.each([
  25,
])("%s files where the chat has no change after the writer's own edits leaves the dock, not a summary with commands and no rows", async (count) => {
  const file = draft("chapter", { itemKey: "draft-a" });
  const files = [
    file,
    ...Array.from({ length: count - 1 }, (_, i) =>
      draft(`chapter${i + 2}`, { itemKey: `draft-${i + 2}` }),
    ),
  ];
  fixture.network.listWorkDrafts.mockResolvedValue({ items: files });
  fixture.network.getThreadDraftFiles.mockResolvedValue({ drafts: files });
  // The chat's only write sits in ids nothing in the room holds: every change in the room is the writer's.
  fixture.network.getDraftAttribution.mockImplementation(async (_p, _w, id) => ({
    revision: [...Y.encodeSnapshot(Y.snapshot(roomDoc(id)))],
    itemKey: "draft-a",
    userId: "user-1",
    edits: [
      {
        threadId: "thread-a",
        title: "Chat A",
        turnId: "turn-1",
        owner: {
          threadId: "thread-a",
          title: "Chat A",
          reveal: { threadId: "thread-a", turnId: "turn-1" },
        },
        at: "2026-10-13T10:00:00Z",
        inserted: [[4_000_000_000, 0, 10]],
        deleted: [],
      },
    ],
  }));
  fixture.network.getDraftMeta.mockImplementation(async (_p, _w, id) => ({
    ...meta,
    itemKey: id === "chapter" ? "draft-a" : `draft-${id.slice("chapter".length)}`,
    roomName: `room-${id}`,
  }));
  await fixture.render(
    async () => {
      expect(document.body.textContent).not.toContain("Apply");
      await settleReact(() => expect(fixture.rooms.has("room-chapter")).toBe(true));
      await settleReact(() => expect(fixture.rooms.has(`room-chapter${count}`)).toBe(true));
      expect(fixture.network.getDraftAttribution).toHaveBeenCalledTimes(count);
      await act(async () => fillRoom("room-chapter", ["It was green."], ["It was red."]));
      await act(async () => {
        for (let i = 2; i <= count; i++)
          fillRoom(`room-chapter${i}`, ["It was green."], ["It was red."]);
      });
      await settleReact(() => expect(document.querySelector("[data-draft-dock-file]")).toBeNull());
      expect(document.querySelector("[data-draft-dock]")).toBeNull();
      expect(document.body.textContent).not.toContain("Apply");
    },
    { chatSurface: <Strip />, host },
  );
});

it("a new document has no live text to return to, so Discard closes its draft on the server", async () => {
  const created = draft("scene", { isNew: true, wholeItem: true, origin: "created" });
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [created] });
  fixture.network.getThreadDraftFiles.mockResolvedValue({ drafts: [created] });
  fixture.network.getDraftMeta.mockResolvedValue({
    kind: "branchless",
    draftId: created.draftId,
    itemKey: created.itemKey,
    documentId: created.documentId,
    isNew: true,
    wholeItem: true,
  } as never);
  let answer: (value: DraftItemDiscardResult) => void = () => {};
  fixture.network.discardDraft.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await fixture.render(
    async () => {
      await settleReact(() => expect(document.querySelector("[data-draft-dock]")).not.toBeNull());
      await clickText("Discard");
      await settleReact(() => expect(fixture.network.discardDraft).toHaveBeenCalledOnce());
      // The collapsed file says so at the click, busy, while the command is out.
      expect(document.querySelector("[role=status][aria-busy]")?.textContent).toContain(
        "Discarding",
      );
      answer({
        status: "discarded",
        draftId: created.draftId,
        itemKey: created.itemKey,
        itemClosed: true,
        itemDisposition: "discarded",
      });
      expect(fixture.network.discardDraft.mock.calls[0][3]).toMatchObject({
        itemKey: created.itemKey,
      });
      expect(open).not.toHaveBeenCalled();
    },
    { chatSurface: <Strip />, host },
  );
});

it("a failed membership read shows Retry on its file, blocks summary Apply, and recovers", async () => {
  const files = [
    draft("chapter", { itemKey: "draft-a" }),
    draft("chapter2", { itemKey: "draft-b" }),
  ];
  fixture.network.listWorkDrafts.mockResolvedValue({ items: files });
  fixture.network.getThreadDraftFiles.mockResolvedValue({ drafts: files });
  fixture.network.getDraftMeta.mockImplementation(async (_p, _w, id) => ({
    ...meta,
    itemKey: id === "chapter" ? "draft-a" : "draft-b",
    roomName: `room-${id}`,
  }));
  let failed = true;
  fixture.network.getDraftAttribution.mockImplementation(async (_p, _w, id) => {
    if (id === "chapter" && failed) throw new Error("attribution HTTP 503");
    const doc = roomDoc(id);
    return {
      itemKey: id === "chapter" ? "draft-a" : "draft-b",
      userId: "u",
      revision: [...Y.encodeSnapshot(Y.snapshot(doc))],
      edits: [
        {
          threadId: "thread-a",
          turnId: "turn",
          title: "Chat",
          at: "2026",
          owner: {
            threadId: "thread-a",
            title: "Chat",
            reveal: { threadId: "thread-a", turnId: "turn" },
          },
          inserted: [[doc.clientID, 0, Y.getState(doc.store, doc.clientID)]],
          deleted: [],
        },
      ],
    };
  });
  await fixture.render(
    async () => {
      await settleReact(() => expect(fixture.rooms.has("room-chapter2")).toBe(true));
      await act(async () => {
        fillRoom("room-chapter", ["green"], ["red"]);
        fillRoom("room-chapter2", ["green"], ["red"]);
      });
      await settleReact(() =>
        expect(
          document.querySelector('[data-draft-dock-file="chapter"] [role=alert]'),
        ).not.toBeNull(),
      );
      expect(document.querySelector("[data-draft-dock]")?.getAttribute("aria-busy")).toBe("false");
      const apply = () =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Apply",
        );
      await settleReact(() => expect(apply()?.disabled).toBe(true));
      failed = false;
      await clickText("Retry changes");
      await settleReact(() => expect(document.querySelector("[role=alert]")).toBeNull());
      expect(apply()?.disabled).toBe(false);
    },
    { chatSurface: <Strip />, host },
  );
});
