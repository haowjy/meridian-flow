/**
 * Review handover: moving from one draft's review to another's.
 *
 * Opening a draft that has not been opened (switcher pick, Apply draft, Discard
 * draft, Next draft) takes the route to another document, whose editor, review
 * room and marks arrive one after the other. Showing the route as it settles
 * is a skeleton with no header between two reviews. So the review being left
 * stays on screen, inert, exactly as it was painted, and the one being opened
 * replaces it in a single frame, when it has painted with its header and marks
 * (`inlineReview.shown`). The same rule as entering a review from live text
 * (`EditorView` holds the live view until the marks arrive), for the case where
 * a whole document is swapped.
 *
 * Navigation still happens first: the route, the tab and the URL change at the
 * click. Only what is painted in the page is held, as markup (the way
 * `FrozenReview` holds a review across a room rebuild), because the DOM it came
 * from is replaced by the route the moment it changes.
 *
 * The owner (`useReviewHandoverOwner`) lives with the launch handoff; the
 * frame goes around the page the review is painted in (desktop page sheet,
 * phone document column).
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";

/** The longest a held review stays if the one being opened never paints. */
const HANDOVER_MAX_MS = 10_000;

export type HandoverTarget = { documentId: string; draftId: string };

type HeldView = {
  id: number;
  /** What the page painted when the move began. */
  html: string;
  /** Scroll offset of each editor scroller in `html`, in document order. */
  scrolls: number[];
  /** The review whose painted header and marks end the hold. */
  target: HandoverTarget;
};

type Capture = (target: HandoverTarget) => Pick<HeldView, "html" | "scrolls"> | null;

export type ReviewHandover = {
  held: HeldView | null;
  /** The page registers how to copy what it paints; returns the unregister. */
  registerCapture: (capture: Capture) => () => void;
  /** A move to `target` begins: hold what is painted. Returns the hold's id for `release`. */
  begin: (target: HandoverTarget) => number;
  /** The move did not happen (failed, cancelled): show the page as it is. */
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
      // A move that follows a move keeps the view the writer last saw painted.
      const view = holding ?? capture.current?.(target) ?? null;
      if (view) hold({ ...view, id, target });
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
  return useMemo(
    () => ({ held, registerCapture, begin, release }),
    [held, registerCapture, begin, release],
  );
}

/**
 * The page a review is painted in. Registers how to copy it and, while a move
 * is held, paints that copy over it. `className` must make the frame the
 * positioning context and size of the page (`relative`).
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
  const review = useRef(controller.inlineReview);
  review.current = controller.inlineReview;

  const registerCapture = handover?.registerCapture;
  useLayoutEffect(
    () =>
      registerCapture?.((target) => {
        const painted = review.current;
        const page = root.current;
        if (!page || !painted?.shown) return null;
        // Opening the review already painted holds nothing.
        if (painted.documentId === target.documentId && painted.draftId === target.draftId)
          return null;
        const copy = page.cloneNode(true) as HTMLElement;
        copy.querySelector("[data-review-cover]")?.remove();
        return {
          html: copy.innerHTML,
          scrolls: Array.from(page.querySelectorAll<HTMLElement>(".meridian-editor"), (editor) =>
            editor.closest("[data-review-cover]") ? 0 : editor.scrollTop,
          ),
        };
      }),
    [registerCapture],
  );

  return (
    <div ref={root} className={className}>
      {children}
      {handover ? <ReviewCover handover={handover} /> : null}
    </div>
  );
}

function ReviewCover({ handover }: { handover: ReviewHandover }) {
  const { controller } = useDraftReview();
  const { held, release } = handover;
  const painted = controller.inlineReview;
  const arrived =
    held !== null &&
    painted?.shown === true &&
    painted.documentId === held.target.documentId &&
    painted.draftId === held.target.draftId;
  const id = held?.id;
  const cover = useRef<HTMLDivElement>(null);

  // Released in the commit that shows the review it was waiting for, so the
  // hold can never outlive its own end: the next move would copy a stale cover.
  useLayoutEffect(() => {
    if (id === undefined) return;
    if (arrived) {
      release(id);
      return;
    }
    const timer = window.setTimeout(() => release(id), HANDOVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [arrived, id, release]);

  const scrolls = held?.scrolls;
  useLayoutEffect(() => {
    const editors = cover.current?.querySelectorAll<HTMLElement>(".meridian-editor");
    editors?.forEach((editor, index) => {
      editor.scrollTop = scrolls?.[index] ?? 0;
    });
  }, [scrolls]);

  if (!held || arrived) return null;
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
