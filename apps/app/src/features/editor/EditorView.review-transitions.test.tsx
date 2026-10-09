// @vitest-environment jsdom
/**
 * What the writer sees as a review is entered, held, left and rebuilt: the live
 * manuscript stays painted until the review has its marks, no transition shows
 * an empty body, and a refused review room is rebuilt under an inert copy. The
 * review's own state is a small stand-in controller here; its completion
 * (pending, closed, not closed) is `EditorView.review-completion.test.tsx`,
 * through the real provider.
 */

import type { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failRebuild,
  finishRebuild,
  refusedRooms,
  registry,
  sessionFor,
  sessionHorizons,
  setConnectionState,
  setSessionStatus,
} from "@/test-support/editor-session-fakes";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorViewProps } from "./EditorView";

const unavailable = vi.fn();
const setInlineReviewShown = vi.fn();
const controller: {
  registerInlineReviewRuntime: () => void;
  releaseInlineReviewRuntime: () => void;
  inlineReviewModelAvailable: () => void;
  setInlineReviewShown: typeof setInlineReviewShown;
  inlineReview: {
    kind: "inline";
    documentId: string;
    draftId: string;
    previewIdentity?: string;
  } | null;
} = {
  registerInlineReviewRuntime: () => {},
  releaseInlineReviewRuntime: () => {},
  inlineReviewModelAvailable: () => {},
  setInlineReviewShown,
  inlineReview: null,
};
/** Whether the review's change marks have arrived; the controller reports it as `previewIdentity`. */
let reviewMarksAvailable = true;

vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false, isFetching: false }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({
    catalog: null,
    isError: false,
    isFetching: false,
    refetch: () => {},
  }),
}));
vi.mock("@/features/change-trail/trail-detail-query", () => ({
  usePrefetchTrailDetails: () => {},
}));
vi.mock("@/features/draft-review/DraftReviewProvider", () => ({
  useDraftReview: () => ({ controller }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useLiveDocumentSessionRegistry: () => registry,
  useOptionalAccountResourceReplica: () => null,
  useAccountResourceProjection: () => ({ snapshot: null, records: [], error: null }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ noWork: { id: "no-work", slug: null, archivedAt: null }, works: [] }),
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: () => ({ documents: [], revision: "", complete: false }),
}));
vi.mock("./references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("./EditorView");

/** The mounted instance, read the way the browser probe reads it. */
function mountedEditor(): Editor {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
  if (!dom?.editor) throw new Error("no mounted editor");
  return dom.editor;
}

let applyProps: (next: Partial<EditorViewProps>) => void = () => {};

function Harness({ initial }: { initial: EditorViewProps }) {
  const [props, setProps] = useState(initial);
  applyProps = (next) => setProps((previous) => ({ ...previous, ...next }));
  controller.inlineReview = props.reviewDraftId
    ? {
        kind: "inline",
        documentId: props.documentId,
        draftId: props.reviewDraftId,
        ...(reviewMarksAvailable ? { previewIdentity: "preview-1" } : {}),
      }
    : null;
  const session = props.reviewDraftId
    ? props.session
    : (props.session ?? sessionFor(props.documentId));
  return <EditorView {...props} session={session} />;
}

describe("review transitions", () => {
  it("never shows an empty body between live and review: live stays until review paints, then Apply reveals the warm live editor", async () => {
    const documentId = "continuity-doc";
    const roomName = "branch:continuity-doc:gen:1";
    let resolveReviewSync!: () => void;
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: new Promise((resolve) => {
        resolveReviewSync = resolve;
      }),
    });
    const visibleEditors = () =>
      [...document.querySelectorAll<HTMLElement>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
    const visibleText = () => visibleEditors().map((dom) => dom.textContent);
    const empty: string[] = [];
    const observer = new MutationObserver(() => {
      if (visibleEditors().length !== 1) empty.push(`${visibleEditors().length} visible editors`);
    });

    const initial = { documentId, projectId: "project-1", session: sessionFor(documentId) };
    await withReactRoot(<Harness initial={initial} />, async () => {
      await act(async () => {
        mountedEditor().commands.insertContent("live words");
      });
      const liveDom = mountedEditor().view.dom;
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      // The review room is still syncing: the live manuscript stays on screen.
      await act(async () => {
        applyProps({ reviewDraftId: "draft-1", reviewRoomName: roomName });
      });
      expect(visibleText()).toEqual(["live words"]);

      // Review paints in one step.
      await act(async () => {
        resolveReviewSync();
        await Promise.resolve();
        await Promise.resolve();
      });
      const reviewDom = [
        ...document.querySelectorAll<HTMLElement & { editor?: Editor }>(".ProseMirror"),
      ].find((dom) => dom !== liveDom);
      expect(visibleEditors()).toEqual([reviewDom]);

      // Apply: review goes straight to the same warm live editor.
      await act(async () => {
        applyProps({ reviewDraftId: null, reviewRoomName: null });
      });
      expect(visibleEditors()).toEqual([liveDom]);
      expect(visibleText()).toEqual(["live words"]);
      observer.disconnect();
      expect(empty).toEqual([]);
    });
  });

  describe("holding the live view until the review has its marks", () => {
    const documentId = "hold-doc";
    const roomName = "branch:hold-doc:gen:1";
    const surfaces = () =>
      [...document.querySelectorAll<HTMLElement>("[data-editor-surface]")]
        .filter((wrapper) => !wrapper.classList.contains("hidden"))
        .map((wrapper) => wrapper.dataset.editorSurface);

    afterEach(() => {
      reviewMarksAvailable = true;
      setInlineReviewShown.mockClear();
      vi.useRealTimers();
    });

    async function enterReview(): Promise<void> {
      sessionHorizons.set(roomName, {
        localPersistence: Promise.resolve(),
        firstServerSync: Promise.resolve(),
      });
      await act(async () => {
        applyProps({ reviewDraftId: "draft-hold", reviewRoomName: roomName });
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it("keeps live on screen, chrome unreported, after the editor exists but before its marks", async () => {
      reviewMarksAvailable = false;
      const initial = { documentId, projectId: "project-1", session: sessionFor(documentId) };
      await withReactRoot(<Harness initial={initial} />, async () => {
        await enterReview();
        expect(surfaces()).toEqual(["live"]);
        expect(setInlineReviewShown).not.toHaveBeenCalledWith(documentId, "draft-hold", true);

        // The marks arrive: body and chrome flip together.
        reviewMarksAvailable = true;
        await act(async () => {
          applyProps({});
        });
        expect(surfaces()).toEqual(["review"]);
        expect(setInlineReviewShown).toHaveBeenLastCalledWith(documentId, "draft-hold", true);
      });
    });

    it("shows the review anyway when its marks never arrive", async () => {
      reviewMarksAvailable = false;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const initial = { documentId, projectId: "project-1", session: sessionFor(documentId) };
      await withReactRoot(<Harness initial={initial} />, async () => {
        await enterReview();
        expect(surfaces()).toEqual(["live"]);
        await act(async () => {
          vi.advanceTimersByTime(1600);
        });
        expect(surfaces()).toEqual(["review"]);
      });
    });
  });

  it("keeps the painted review editor when the live binding is re-minted under it", async () => {
    // A rename re-mints the host's binding key for the live session. The branch
    // review has its own session, so it must neither remount nor hand the screen
    // back to the live text.
    const documentId = "rename-review-doc";
    const roomName = "branch:rename-review-doc:gen:1";
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: Promise.resolve(),
    });
    const initial = {
      documentId,
      projectId: "project-1",
      session: sessionFor(documentId),
      bindingKey: "binding-1",
    };
    await withReactRoot(<Harness initial={initial} />, async () => {
      await act(async () => {
        applyProps({ reviewDraftId: "draft-1", reviewRoomName: roomName });
        await Promise.resolve();
        await Promise.resolve();
      });
      const painted = [...document.querySelectorAll<HTMLElement>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
      expect(painted).toHaveLength(1);

      await act(async () => {
        applyProps({ bindingKey: "binding-2" });
      });
      const after = [...document.querySelectorAll<HTMLElement>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
      expect(after).toHaveLength(1);
      expect(after[0]).toBe(painted[0]);
    });
  });

  it("keeps the live manuscript painted but read-only from the Review click until the branch editor paints", async () => {
    const documentId = "pending-review-doc";
    const roomName = "branch:pending-review-doc:gen:1";
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: new Promise(() => undefined),
    });
    await withReactRoot(
      <Harness initial={{ documentId, session: sessionFor(documentId) }} />,
      async () => {
        const live = mountedEditor();
        await act(async () => {
          live.commands.insertContent("live words");
        });

        // Review is intended but its room is still resolving, then still syncing.
        await act(async () => {
          applyProps({ reviewDraftId: "draft-pending" });
        });
        expect(live.isEditable).toBe(false);
        expect(live.view.dom.closest(".hidden")).toBeNull();
        await act(async () => {
          applyProps({ reviewRoomName: roomName });
        });
        expect(live.isEditable).toBe(false);
        expect(live.view.dom.closest(".hidden")).toBeNull();
        expect(live.getText()).toBe("live words");

        // Leaving review restores writing on the same warm editor.
        await act(async () => {
          applyProps({ reviewDraftId: null, reviewRoomName: null });
        });
        expect(mountedEditor()).toBe(live);
        expect(live.isEditable).toBe(true);
      },
    );
  });

  it("shows the pending shell for a draft-only review, with no live editor to keep painted", async () => {
    const roomName = "branch:draft-only:gen:1";
    sessionHorizons.set(roomName, {
      localPersistence: Promise.resolve(),
      firstServerSync: new Promise(() => undefined),
    });
    await withReactRoot(
      <EditorView documentId="draft-only" reviewDraftId="draft-only-1" reviewRoomName={roomName} />,
      async () => {
        const shells = [...document.querySelectorAll(".meridian-editor-shell")];
        expect(shells).toHaveLength(1);
        expect(shells.filter((shell) => !shell.closest(".hidden"))).toHaveLength(1);
      },
    );
  });

  describe("a review room the server has moved past", () => {
    const roomStale = vi.fn();
    let nextCase = 0;

    /**
     * Mount a review of its own document (sessions outlive a test), let `drive`
     * change its room, and leave `unavailable` and `roomStale` holding who was told.
     */
    async function drivenBy(
      drive: (roomName: string) => void,
      onReviewRoomStale: typeof roomStale | null = roomStale,
    ) {
      nextCase += 1;
      const documentId = `moved-past-${nextCase}`;
      const roomName = `branch:${documentId}:gen:1`;
      unavailable.mockClear();
      roomStale.mockClear();
      await withReactRoot(
        <Harness
          initial={{
            documentId,
            reviewDraftId: "draft-moved",
            reviewRoomName: roomName,
            onReviewSessionUnavailable: unavailable,
            ...(onReviewRoomStale ? { onReviewRoomStale } : {}),
          }}
        />,
        async () => {
          await act(async () => drive(roomName));
        },
      );
      return { documentId, roomName };
    }

    it.each([
      "branch-generation-stale",
      "branch-stale-doc",
    ] as const)("hands %s to the review's owner and does not leave review", async (reason) => {
      const { documentId, roomName } = await drivenBy((room) =>
        setConnectionState(room, { kind: "reset", reason, code: 4205 }),
      );
      expect(roomStale).toHaveBeenCalledWith(documentId, "draft-moved", roomName);
      expect(unavailable).not.toHaveBeenCalled();
    });

    it.each([
      [
        "unauthorized",
        (room: string) => setConnectionState(room, { kind: "unauthorized", reason: "x" }),
      ],
      ["terminal", (room: string) => setConnectionState(room, { kind: "terminal", reason: "x" })],
      [
        "a reset for any other reason",
        (room: string) =>
          setConnectionState(room, { kind: "reset", reason: "access-changed", code: 4409 }),
      ],
      ["a destroyed session", (room: string) => setSessionStatus(room, "destroyed")],
    ] as const)("still leaves review on %s", async (_state, drive) => {
      await drivenBy(drive);
      expect(unavailable).toHaveBeenCalled();
      expect(roomStale).not.toHaveBeenCalled();
    });

    it("leaves review as before when nobody can take the signal", async () => {
      await drivenBy(
        (room) => setConnectionState(room, { kind: "reset", reason: "branch-generation-stale" }),
        null,
      );
      expect(unavailable).toHaveBeenCalled();
    });
  });

  describe("a refused branch room rebuilt under a painted review", () => {
    const visibleEditors = () =>
      [...document.querySelectorAll<HTMLElement & { editor?: Editor }>(".ProseMirror")].filter(
        (dom) => !dom.closest(".hidden"),
      );
    const visibleText = () =>
      [...document.querySelectorAll<HTMLElement>(".meridian-editor-shell")]
        .filter((shell) => !shell.closest(".hidden"))
        .map((shell) => shell.textContent);
    async function refuse(roomName: string) {
      refusedRooms.add(roomName);
      await act(async () => {
        setConnectionState(roomName, { kind: "reset", reason: "access-changed", code: 4409 });
      });
    }

    it("keeps the review on screen, inert, until the rebuilt room paints, and never shows live prose", async () => {
      const documentId = "rebuild-live-doc";
      const roomName = "branch:rebuild-live-doc:gen:1";
      const initial = { documentId, session: sessionFor(documentId) };
      await withReactRoot(<Harness initial={initial} />, async () => {
        await act(async () => {
          mountedEditor().commands.insertContent("LIVE MANUSCRIPT");
        });
        await act(async () => {
          applyProps({ reviewDraftId: "draft-rebuild", reviewRoomName: roomName });
        });
        await act(async () => {
          visibleEditors()[0]?.editor?.commands.insertContent("DRAFT REVIEW");
        });
        expect(visibleText()).toEqual(["DRAFT REVIEW"]);

        await refuse(roomName);
        // The replacement is still syncing: the review as painted stays, and nothing can type into it.
        expect(visibleText().join("")).toContain("DRAFT REVIEW");
        expect(visibleText().join("")).not.toContain("LIVE MANUSCRIPT");
        const held = document.querySelector("[data-review-replacing]");
        expect(held?.hasAttribute("inert")).toBe(true);
        expect(held?.getAttribute("aria-hidden")).toBe("true");
        expect(document.querySelectorAll("[data-review-replacing] .ProseMirror")).toHaveLength(1);
        expect(visibleEditors().filter((dom) => !dom.closest("[data-review-replacing]"))).toEqual(
          [],
        );

        // The rebuilt room paints: the held copy is gone and the review is a live editor again.
        await act(async () => {
          finishRebuild(roomName);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(document.querySelector("[data-review-replacing]")).toBeNull();
        expect(visibleEditors()).toHaveLength(1);
        expect(visibleEditors()[0]?.closest(".hidden")).toBeNull();
        expect(visibleText().join("")).not.toContain("LIVE MANUSCRIPT");
      });
    });

    it("holds the review for a draft-only document, which has no live prose to fall back to", async () => {
      const roomName = "branch:rebuild-draft-only:gen:1";
      await withReactRoot(
        <Harness
          initial={{
            documentId: "rebuild-draft-only",
            reviewDraftId: "draft-only-rebuild",
            reviewRoomName: roomName,
          }}
        />,
        async () => {
          await act(async () => {
            visibleEditors()[0]?.editor?.commands.insertContent("DRAFT ONLY REVIEW");
          });
          await refuse(roomName);
          expect(document.querySelectorAll(".meridian-editor-shell")).toHaveLength(1);
          expect(document.querySelector("[data-review-replacing]")?.textContent).toContain(
            "DRAFT ONLY REVIEW",
          );
        },
      );
    });

    it("hands the screen back to the live prose when the review is actually left", async () => {
      const documentId = "rebuild-leave-doc";
      const roomName = "branch:rebuild-leave-doc:gen:1";
      await withReactRoot(
        <Harness initial={{ documentId, session: sessionFor(documentId) }} />,
        async () => {
          await act(async () => {
            mountedEditor().commands.insertContent("LIVE MANUSCRIPT");
          });
          await act(async () => {
            applyProps({ reviewDraftId: "draft-leave", reviewRoomName: roomName });
          });
          await refuse(roomName);
          await act(async () => {
            applyProps({ reviewDraftId: null, reviewRoomName: null });
          });
          expect(document.querySelector("[data-review-replacing]")).toBeNull();
          expect(visibleText().join("")).toContain("LIVE MANUSCRIPT");
        },
      );
    });
    it("never shows the previous review's frozen prose under a different review identity", async () => {
      const roomA = "branch:frozen-switch-a:gen:1";
      const roomB = "branch:frozen-switch-b:gen:1";
      sessionHorizons.set(roomB, {
        localPersistence: Promise.resolve(),
        firstServerSync: new Promise(() => undefined),
      });
      await withReactRoot(
        <Harness
          initial={{
            documentId: "freeze-switch",
            reviewDraftId: "draft-a",
            reviewRoomName: roomA,
          }}
        />,
        async () => {
          await act(async () => {
            visibleEditors()[0]?.editor?.commands.insertContent("PRIVATE REVIEW A");
          });
          await refuse(roomA);
          expect(document.querySelector("[data-review-replacing]")?.textContent).toContain(
            "PRIVATE REVIEW A",
          );
          await act(async () => {
            applyProps({ reviewDraftId: "draft-b", reviewRoomName: roomB });
          });
          expect(document.body.textContent).not.toContain("PRIVATE REVIEW A");
        },
      );
    });

    it("ignores a retired rebuild finishing after another review has bound", async () => {
      const roomA = "branch:late-switch-a:gen:1";
      const roomB = "branch:late-switch-b:gen:1";
      await withReactRoot(
        <Harness
          initial={{ documentId: "late-switch", reviewDraftId: "draft-a", reviewRoomName: roomA }}
        />,
        async () => {
          await refuse(roomA);
          await act(async () => {
            applyProps({ reviewDraftId: "draft-b", reviewRoomName: roomB });
          });
          await act(async () => {
            visibleEditors()[0]?.editor?.commands.insertContent("REVIEW B");
          });
          await act(async () => {
            finishRebuild(roomA);
            await Promise.resolve();
          });
          expect(document.body.textContent).toContain("REVIEW B");
        },
      );
    });

    it("ignores a retired rebuild failing after the review was left", async () => {
      const roomName = "branch:late-leave-failure:gen:1";
      unavailable.mockClear();
      await withReactRoot(
        <Harness
          initial={{
            documentId: "late-leave-failure",
            reviewDraftId: "draft-left",
            reviewRoomName: roomName,
            onReviewSessionUnavailable: unavailable,
          }}
        />,
        async () => {
          await refuse(roomName);
          await act(async () => {
            applyProps({ reviewDraftId: null, reviewRoomName: null });
          });
          await act(async () => {
            failRebuild();
            await Promise.resolve();
          });
          expect(unavailable).not.toHaveBeenCalled();
        },
      );
    });

    it("reports the failure of the rebuild that is still current", async () => {
      const roomName = "branch:current-failure:gen:1";
      unavailable.mockClear();
      await withReactRoot(
        <Harness
          initial={{
            documentId: "current-failure",
            reviewDraftId: "draft-current",
            reviewRoomName: roomName,
            onReviewSessionUnavailable: unavailable,
          }}
        />,
        async () => {
          await refuse(roomName);
          await act(async () => {
            failRebuild();
            await Promise.resolve();
          });
          expect(unavailable).toHaveBeenCalledOnce();
        },
      );
    });
  });
});
