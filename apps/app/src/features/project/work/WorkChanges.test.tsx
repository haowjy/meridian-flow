// @vitest-environment jsdom
/**
 * The Work page's Changes to review: Apply all and Discard all act on every draft of the Work whatever the
 * search box filters, and read each unopened draft's room for the length of its Apply.
 */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, type ReactNode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocumentSession } from "@/core/editor/document-session";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { createReviewScopeFixture, listed, workC } from "@/test-support/draft-review-scope";
import { seedReviewBase } from "@/test-support/inline-review-editor";
import { settleReact } from "@/test-support/react-dom-harness";
import { WorkChanges } from "./WorkChanges";

let fixture: ReturnType<typeof createReviewScopeFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  fixture = createReviewScopeFixture();
  vi.spyOn(projectsApi, "listProjectWorks").mockReturnValue(new Promise(() => {}));
  vi.spyOn(handoff, "useOpenEditorReview").mockReturnValue(vi.fn().mockResolvedValue(undefined));
});
afterEach(() => {
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const draftOf = (id: string, name: string) => ({
  ...listed,
  documentId: `document-${id}`,
  itemKey: `draft-${id}`,
  documentName: name,
  contextLocation: { scheme: "manuscript" as const, path: `/${id}.md` },
});

function Page() {
  const [filter, setFilter] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setFilter(true)}>
        Filter files
      </button>
      <WorkChanges
        projectId="project-a"
        work={workC}
        matchesSearch={(name) => !filter || name === "Chapter 13"}
      />
    </>
  );
}
function Desktop({ children }: { children: ReactNode }) {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as never;
  return children;
}
const find = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent)?.trim() === label,
  );
const press = (label: string) => act(async () => find(label)?.click());
/** Radix opens a menu on the key, not the click. */
const openMenu = () =>
  act(async () =>
    find("All changes")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );

const host = (children: ReactNode) => (
  <I18nProvider i18n={i18n}>
    <TooltipProvider>
      <ChatThreadNavigationProvider onOpenThread={vi.fn()}>
        <ProjectNavigationProvider openContextRoute={vi.fn()} openWork={vi.fn()}>
          <Desktop>{children}</Desktop>
        </ProjectNavigationProvider>
      </ChatThreadNavigationProvider>
    </TooltipProvider>
  </I18nProvider>
);

it("Apply all is one command over every listed draft, even files the search hides", async () => {
  const items = [draftOf("b", "Chapter 13"), draftOf("c", "Filtered chapter")];
  fixture.network.listWorkDrafts.mockResolvedValue({ items });
  fixture.network.applyAllDrafts.mockResolvedValue({
    status: "completed",
    draftId: listed.draftId,
    items: items.map((item) => ({
      status: "applied",
      itemKey: item.itemKey,
      itemClosed: false,
      overrode: [],
    })),
  } as never);
  await fixture.render(
    async () => {
      await settleReact(() => expect(document.body.textContent).toContain("Chapter 13"));
      await press("Filter files");
      await openMenu();
      await press("Apply all changes");
      await settleReact(() => expect(fixture.network.applyAllDrafts).toHaveBeenCalledOnce());
      const request = fixture.network.applyAllDrafts.mock.calls[0][2];
      expect(request.draftId).toBe(listed.draftId);
      expect(request.items.map((item) => item.itemKey)).toEqual(["draft-b", "draft-c"]);
    },
    { surface: <Page />, host },
  );
});

it("Discard all asks first, then closes the Work's draft with one command, so a running reply opens a new draft", async () => {
  const items = [draftOf("b", "Chapter 13"), draftOf("c", "Filtered chapter")];
  fixture.network.listWorkDrafts.mockResolvedValue({ items });
  fixture.network.discardAllDrafts.mockResolvedValue({
    status: "discarded",
    draftId: listed.draftId,
  });
  await fixture.render(
    async () => {
      await settleReact(() => expect(document.body.textContent).toContain("Chapter 13"));
      await openMenu();
      await press("Discard all changes");
      expect(fixture.network.discardAllDrafts).not.toHaveBeenCalled();
      await press("Discard");
      await settleReact(() => expect(fixture.network.discardAllDrafts).toHaveBeenCalledOnce());
      expect(fixture.network.discardAllDrafts.mock.calls[0][2]).toMatchObject({
        draftId: listed.draftId,
      });
      expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    },
    { surface: <Page />, host },
  );
});

it("a new document's row Discard closes the item on the server instead of editing text", async () => {
  const created = {
    ...draftOf("b", "Chapter 13"),
    isNew: true,
    wholeItem: true,
    origin: "created" as const,
  };
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [created] });
  fixture.network.getDraftMeta.mockResolvedValue({
    kind: "branchless",
    draftId: listed.draftId,
    itemKey: created.itemKey,
    documentId: created.documentId,
    isNew: true,
    wholeItem: true,
  } as never);
  fixture.network.discardDraft.mockResolvedValue({
    status: "discarded",
    draftId: listed.draftId,
    itemKey: created.itemKey,
    itemClosed: true,
    itemDisposition: "discarded",
  });
  await fixture.render(
    async () => {
      await settleReact(() => expect(document.body.textContent).toContain("Chapter 13"));
      await act(async () =>
        document.querySelector<HTMLElement>('[aria-label="Changes in Chapter 13"]')?.click(),
      );
      await settleReact(() => expect(find("Discard")).toBeDefined());
      await press("Discard");
      await settleReact(() => expect(fixture.network.discardDraft).toHaveBeenCalledOnce());
      expect(fixture.network.discardDraft.mock.calls[0][3]).toMatchObject({
        itemKey: created.itemKey,
      });
    },
    { surface: <Page />, host },
  );
});

it("a refused Apply whose only change a peer removed keeps the file and says why, even once the list drops it", async () => {
  const item = draftOf("b", "Chapter 13");
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [item] });
  fixture.network.getDraftAttribution.mockResolvedValue({ edits: [] } as never);
  fixture.network.getDraftMeta.mockResolvedValue({
    kind: "text",
    draftId: item.draftId,
    itemKey: item.itemKey,
    documentId: item.documentId,
    roomName: "review-room-b",
    wholeItem: false,
    isNew: false,
  } as never);
  const room = new DocumentSession({ roomKey: "review-room-b", persistence: { kind: "none" } });
  room.whenSynced = () => Promise.resolve();
  fixture.rooms.set("review-room-b", room);
  seedReviewBase(room.document, ["Door red."]);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, "Door green.");
  room.document.getXmlFragment("prosemirror").insert(0, [paragraph]);
  let answer!: (value: never) => void;
  fixture.network.applyDraftChanges.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await fixture.render(
    async () => {
      await settleReact(() => expect(find("Changes in Chapter 13")).toBeDefined());
      await press("Changes in Chapter 13");
      await settleReact(() => expect(find("Apply")).toBeDefined());
      await press("Apply");
      await settleReact(() => expect(fixture.network.applyDraftChanges).toHaveBeenCalledOnce());
      await act(async () => {
        room.document.transact(() => {
          text.delete(0, text.length);
          text.insert(0, "Door red.");
        }, "peer");
        await vi.advanceTimersByTimeAsync(150);
      });
      fixture.network.listWorkDrafts.mockResolvedValue({ items: [] });
      await act(async () => {
        answer({
          status: "held",
          draftId: item.draftId,
          itemKey: item.itemKey,
          reason: { code: "clash" },
        } as never);
      });
      await settleReact(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
      expect(document.body.textContent).toContain("Chapter 13");
    },
    { surface: <Page />, host },
  );
});
