/**
 * Review handover: moving from one draft's review to another's.
 *
 * Opening a draft that has not been opened (switcher pick, Apply draft, Discard
 * draft, Next draft, Open on a refused draft) takes the route to another
 * document, whose editor, review room and marks arrive one after the other.
 * Showing the route as it settles is a skeleton with no header between two
 * reviews. So the review being left stays on screen exactly as it was painted,
 * and the one being opened replaces it in a single frame, when it has painted
 * with its header and marks (`inlineReview.shown`). The same rule as entering a
 * review from live text (`EditorView` holds the live view until the marks
 * arrive), for the case where a whole document is swapped.
 *
 * Navigation still happens first: the route, the tab and the URL change at the
 * click. Only what is painted in the page is held, as markup (the way
 * `FrozenReview` holds a review across a room rebuild), because the DOM it came
 * from is replaced by the route the moment it changes.
 *
 * One hold has one owner (`useReviewHandoverOwner`, with the launch handoff), and
 * the hold is keyed to the review it waits for:
 *
 * - the **destination** is that review (`target`); the retained painted view
 *   (`html`) only stands in for it and is never state of its own;
 * - **input** is suppressed on the real page under the copy for as long as the
 *   hold lasts (`ReviewHandoverFrame`): the copy being inert is not enough, the
 *   page behind it is what a click, a key or a screen reader would reach;
 * - it **ends** when the target paints, when its review room fails or its
 *   review is left, when the route goes anywhere but the page the move started
 *   from or the target (`useReviewHandoverRelease`, in the always-mounted
 *   address owner), and at an absolute expiry set when the view was captured,
 *   which no page's mount or unmount can extend.
 */
import { t } from "@lingui/core/macro";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type DraftReviewContextValue, useDraftReview } from "@/features/chat/DraftReviewProvider";

/** The longest a held review stays if the one being opened never paints. */
const HANDOVER_MAX_MS = 10_000;

export type HandoverTarget = { documentId: string; draftId: string; documentName?: string };

type HeldView = {
  id: number;
  /** What the page painted when the move began. */
  html: string;
  /** Scroll offset of each editor scroller in `html`, in document order. */
  scrolls: number[];
  /** Keyboard focus was inside the page when the move began, so it needs a place to go. */
  focused: boolean;
  /** The review whose painted header and marks end the hold. */
  target: HandoverTarget;
  /** Set when the view was captured; a move that follows a move keeps it. */
  expiresAt: number;
};

type Captured = Pick<HeldView, "html" | "scrolls" | "focused">;
type Capture = (target: HandoverTarget) => Captured | null;

export type ReviewHandover = {
  held: HeldView | null;
  /** The page registers how to copy what it paints; returns the unregister. */
  registerCapture: (capture: Capture) => () => void;
  /** A move to `target` begins: hold what is painted. Returns the hold's id for `release`. */
  begin: (target: HandoverTarget) => number;
  /** The move did not happen (failed, cancelled), or the hold ended: show the page as it is. */
  release: (id: number) => void;
};

export const ReviewHandoverContext = createContext<ReviewHandover | null>(null);

export function useReviewHandoverOwner(): ReviewHandover {
  const [held, setHeld] = useState<HeldView | null>(null);
  const heldRef = useRef<HeldView | null>(null);
  const capture = useRef<Capture | null>(null);
  const sequence = useRef(0);

  const hold = useCallback((next: HeldView | null) => {
    heldRef.current = next;
    setHeld(next);
  }, []);
  const registerCapture = useCallback((register: Capture) => {
    capture.current = register;
    return () => {
      if (capture.current === register) capture.current = null;
    };
  }, []);
  const begin = useCallback(
    (target: HandoverTarget) => {
      const id = ++sequence.current;
      const holding = heldRef.current;
      // A move that follows a move keeps the view the writer last saw painted,
      // and the time it was given.
      const view = holding ?? capture.current?.(target) ?? null;
      if (view)
        hold({
          ...view,
          id,
          target,
          expiresAt: holding?.expiresAt ?? Date.now() + HANDOVER_MAX_MS,
        });
      return id;
    },
    [hold],
  );
  const release = useCallback(
    (id: number) => {
      if (heldRef.current?.id === id) hold(null);
    },
    [hold],
  );

  // The owner outlives every page, so the expiry cannot be lost with one.
  const id = held?.id;
  const expiresAt = held?.expiresAt;
  useEffect(() => {
    if (id === undefined || expiresAt === undefined) return;
    const timer = window.setTimeout(() => release(id), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [id, expiresAt, release]);

  return useMemo(
    () => ({ held, registerCapture, begin, release }),
    [held, registerCapture, begin, release],
  );
}

/** Where the Editor route is, as far as a hold cares; `documentId` is absent while the address resolves. */
export type HandoverRoute = {
  screen: string;
  scheme: string | null;
  documentId: string | null | undefined;
};

/**
 * Where the writer is: a review is painted on one document of the manuscript on
 * the Editor screen; anywhere else is just somewhere else. `null` while the
 * address is still resolving to a document, when nothing can be said.
 */
function routeKey(route: HandoverRoute): string | null {
  if (route.screen !== EDITOR_SCREEN || route.scheme !== EDITOR_SCHEME)
    return `${route.screen}|${route.scheme}`;
  return route.documentId ? `${EDITOR_SCREEN}|${EDITOR_SCHEME}|${route.documentId}` : null;
}
const EDITOR_SCREEN = "context";
const EDITOR_SCHEME = "manuscript";

type Latch = { id: number; origin: string | null; reached: boolean; claimed: boolean };

/**
 * Ends the hold when what it waits for is no longer where the writer is. Mount
 * it where the route and the review controller are both known and which stays
 * mounted for the project (the address owner): the hold must not depend on a
 * page that can unmount.
 *
 * The route may sit on the page the move started from until it applies, and on
 * the target once it has; anywhere else is the writer going somewhere. Once the
 * target has been reached, leaving it ends the hold.
 */
export function useReviewHandoverRelease(review: DraftReviewContextValue, route: HandoverRoute) {
  const handover = useContext(ReviewHandoverContext);
  const latch = useRef<Latch | null>(null);
  const { inlineReview, reviewRoomError } = review.controller;
  const key = routeKey(route);

  useLayoutEffect(() => {
    const held = handover?.held;
    if (!held) {
      latch.current = null;
      return;
    }
    if (latch.current?.id !== held.id) {
      latch.current = { id: held.id, origin: null, reached: false, claimed: false };
    }
    const state = latch.current;
    const { target } = held;
    const release = () => handover?.release(held.id);

    const entered =
      inlineReview?.documentId === target.documentId && inlineReview.draftId === target.draftId;
    if (entered) {
      // The review it waits for has painted: the swap is this commit.
      if (inlineReview.shown) return release();
      // It could not load: the page says so itself.
      if (reviewRoomError) return release();
      state.claimed = true;
    } else if (state.claimed) {
      // It was entered and the writer has left it.
      return release();
    }

    if (key === null) return;
    if (key === `${EDITOR_SCREEN}|${EDITOR_SCHEME}|${target.documentId}`) state.reached = true;
    else if (state.reached) return release();
    else if (state.origin === null) state.origin = key;
    else if (state.origin !== key) return release();
  });
}

/**
 * The page a review is painted in. Registers how to copy it and, while a move
 * is held, paints that copy over it and makes the page itself non-interactive.
 * `className` must make the frame the positioning context and size of the page
 * (`relative`). Anything that must stay usable during a move (tabs, sidebar)
 * lives outside this frame.
 */
export function ReviewHandoverFrame({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const handover = useContext(ReviewHandoverContext);
  const { controller } = useDraftReview();
  const root = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const review = useRef(controller.inlineReview);
  review.current = controller.inlineReview;

  const registerCapture = handover?.registerCapture;
  useLayoutEffect(
    () =>
      registerCapture?.((target) => {
        const painted = review.current;
        const host = page.current;
        if (!host || !painted?.shown) return null;
        // Opening the review already painted holds nothing.
        if (painted.documentId === target.documentId && painted.draftId === target.draftId)
          return null;
        return {
          html: host.innerHTML,
          scrolls: Array.from(
            host.querySelectorAll<HTMLElement>(".meridian-editor"),
            (editor) => editor.scrollTop,
          ),
          focused: host.contains(document.activeElement),
        };
      }),
    [registerCapture],
  );

  const held = handover?.held ?? null;
  const holding = held !== null;
  // Focus inside a page that is about to be inert has nowhere to stay: it goes to
  // the status line, outside the page, and comes back to the frame with the page.
  const heldId = held?.id;
  const heldFocus = held?.focused;
  useLayoutEffect(() => {
    if (heldId === undefined || !heldFocus) return;
    status.current?.focus({ preventScroll: true });
  }, [heldId, heldFocus]);
  // In the layout phase, not a cleanup: React puts focus back on the element it
  // saw focused when a commit began, after the cleanups have run.
  const wasHolding = useRef(false);
  useLayoutEffect(() => {
    const ended = wasHolding.current && !holding;
    wasHolding.current = holding;
    const frame = root.current;
    if (!ended || !frame || document.activeElement !== status.current) return;
    frame.setAttribute("tabindex", "-1");
    frame.addEventListener("blur", () => frame.removeAttribute("tabindex"), { once: true });
    frame.focus({ preventScroll: true });
  }, [holding]);

  const name = held?.target.documentName;
  const opening = !held ? "" : name ? t`Opening ${name}` : t`Opening draft`;

  return (
    <div
      ref={root}
      data-review-handover
      className={className ? `${className} outline-none` : "outline-none"}
    >
      {/* The page the review is painted in. While a move is held it is the page
          being opened: it keeps mounting and loading, but nothing in it can be
          clicked, focused or read until its review has painted. */}
      <div
        ref={page}
        data-review-destination
        className="contents"
        inert={holding ? true : undefined}
      >
        {children}
      </div>
      <p
        ref={status}
        data-review-handover-status
        role="status"
        tabIndex={-1}
        className="sr-only outline-none"
      >
        {opening}
      </p>
      {held ? <ReviewCover held={held} /> : null}
    </div>
  );
}

function ReviewCover({ held }: { held: HeldView }) {
  const cover = useRef<HTMLDivElement>(null);
  const scrolls = held.scrolls;
  useLayoutEffect(() => {
    const editors = cover.current?.querySelectorAll<HTMLElement>(".meridian-editor");
    editors?.forEach((editor, index) => {
      editor.scrollTop = scrolls[index] ?? 0;
    });
  }, [scrolls]);

  return (
    <div
      ref={cover}
      // The review as it was painted; nothing in it takes input or is announced.
      inert
      aria-hidden
      data-review-cover
      className="absolute inset-0 z-40 flex flex-col overflow-hidden bg-background"
      // The copy is the DOM this page already rendered, never document text parsed again.
      dangerouslySetInnerHTML={{ __html: held.html }}
    />
  );
}
