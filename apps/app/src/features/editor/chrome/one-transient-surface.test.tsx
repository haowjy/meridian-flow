// @vitest-environment jsdom
/**
 * Law 4 across lane boundaries: one transient surface, one owner of Escape.
 *
 * The kernel can only enforce that over surfaces it knows about, so the
 * regression these guard is a surface that renders a Radix root of its own and
 * registers no layer. Both cases here were exactly that — the peer-mark popover
 * and the dialog an unresolved follow opens — and both were reachable from the
 * writer's ordinary path: open a peer's change and press Mod+K, or click a link
 * whose answer takes longer than the checking delay and summon something else
 * while it is in flight.
 *
 * The kernel's layer list is the assertion rather than the DOM: what went wrong
 * was never "nothing rendered", it was two surfaces live at once.
 */
import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { getEditorChrome } from "@/core/editor/chrome";
import { PeerMarkerExtension, peerMarks } from "@/core/editor/extensions/PeerMarkerExtension";
import { getLinkSurface } from "@/core/editor/links";
import { SessionMarkerStore } from "@/core/editor/session-marker-store";
import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";

import { FollowOutcomeDialog, LinkSurfaces } from "../surfaces/link";
import { PeerMarkSurface } from "../surfaces/peer-marks";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
  msg: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: <T,>(options: T) => options,
  useQueryClient: () => ({ removeQueries: () => {} }),
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
}));
vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ isPending: false, mutateAsync: async () => null }),
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({ observe: () => () => {} }),
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => async () => true,
}));

let page: ReactEditorFixture;

beforeEach(() => {
  const markerStore = new SessionMarkerStore("writer-1");
  markerStore.replaceGroup(peerChange());
  page = createReactEditorFixture({
    extensions: [PeerMarkerExtension.configure({ markerStore })],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a sentence" }] }],
    },
  });
});

afterEach(() => {
  page.destroy();
});

describe("one transient surface", () => {
  it("closes the peer popover when Mod+K opens the link form", () => {
    const editor = page.editor;
    const lane = peerMarks(editor);
    if (!lane) throw new Error("peer marks did not mount");

    page.render(
      <>
        <PeerMarkSurface editor={editor} />
        <LinkSurfaces editor={editor} />
      </>,
    );
    act(() => {
      lane.press.open({
        changeId: "change-1",
        activation: "pointer",
        editorSelection: { from: 1, to: 1, relative: null },
      });
    });
    expect(layerIds()).toEqual(["peer-mark"]);

    act(() => pressModK(editor));

    // The form is open, the popover is not, and the kernel holds one layer: the
    // failure this guards left both surfaces live and Escape with two owners.
    expect(getLinkSurface(editor)?.state.form).not.toBeNull();
    expect(lane.press.press).toBeNull();
    expect(layerIds()).toEqual(["link-form"]);
  });

  it("closes a summoned surface when a follow reports what it found", () => {
    const editor = page.editor;
    const surface = getLinkSurface(editor);
    if (!surface) throw new Error("link lane did not mount");

    page.render(
      <>
        <LinkSurfaces editor={editor} />
        <FollowOutcomeDialog editor={editor} />
      </>,
    );
    act(() => pressModK(editor));
    expect(layerIds()).toEqual(["link-form"]);

    // A quarter second after the click, which is long enough for the writer to
    // have summoned something else.
    act(() => {
      surface.reportFollow({ state: "missing", target: { kind: "wikilink", name: "The Gate" } });
    });

    expect(surface.state.form).toBeNull();
    expect(layerIds()).toEqual(["link-follow-outcome"]);
  });
});

/** Layer ids without the per-instance suffix `useChromeLayer` adds. */
function layerIds(): string[] {
  const chrome = getEditorChrome(page.editor);
  if (!chrome) throw new Error("kernel did not mount");
  return chrome.layers.map((layer) => layer.id.replace(/#.*$/, ""));
}

function pressModK(instance: Editor): void {
  instance.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

/** One agent change on the document, as the session would report it. */
function peerChange(): ChangeEventWsMessage {
  const doc = new Y.Doc();
  const position = Y.createRelativePositionFromTypeIndex(doc.getXmlFragment("prosemirror"), 0);
  const bytes = Y.encodeRelativePosition(position);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const relative = btoa(binary);

  return {
    type: "change_event",
    documentId: "document-1",
    threadId: "thread-1",
    trailId: "trail-1",
    projectionRevision: 1,
    author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
    changes: [
      {
        admittedByUserId: null,
        changeId: "change-1",
        kind: "modify",
        navigation: {
          kind: "live_block_range",
          relStart: relative,
          relEnd: relative,
          targetBlockId: { clientID: 1, clock: 0 },
        },
        swept: false,
        excerpt: "a sentence",
        pureDeletionOffset: null,
      },
    ],
    truncated: false,
  };
}
