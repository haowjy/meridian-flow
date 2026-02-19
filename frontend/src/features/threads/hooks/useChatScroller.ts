import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

interface UseChatScrollerProps {
  /** Thread-level reset key - triggers content gating (hide -> scroll -> reveal). */
  threadResetKey: string | null;
  scrollContainer: HTMLElement | null;
  turnIds: string[];
  /** Turn to scroll to. Changes within same thread scroll without hiding. */
  scrollToTurnId: string | undefined;
  isLoading: boolean;
  isStreaming: boolean;
  onScrollToBottom?: () => void;
  /** Distance from bottom (px) to consider "at bottom". Default: 50 */
  nearBottomThreshold?: number;
  /** Number of stable frames before revealing content. Default: 10 */
  initialStableFrames?: number;
}

interface UseChatScrollerReturn {
  isContentReady: boolean;
  showScrollButton: boolean;
  scrollToBottom: () => void;
  listRef: RefObject<HTMLDivElement | null>;
}

/**
 * Simplified scroll controller for chat-style thread view.
 *
 * With a fixed-height composer, we no longer need:
 * - Anchor capture/restore for textarea resize
 * - Typing guards to prevent browser caret adjustments
 * - Complex RAF loops for resize compensation
 *
 * This hook handles:
 * 1. Initial scroll to bookmarked turn (or bottom) with content gating
 * 2. Auto-follow during streaming via ResizeObserver
 * 3. Pause/resume follow based on user scroll intent
 * 4. Scroll-to-bottom button visibility
 */
export function useChatScroller({
  threadResetKey,
  scrollContainer,
  turnIds,
  scrollToTurnId,
  isLoading,
  isStreaming,
  onScrollToBottom,
  nearBottomThreshold = 50,
  initialStableFrames = 10,
}: UseChatScrollerProps): UseChatScrollerReturn {
  const [isContentReady, setIsContentReady] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Whether we're auto-following streaming output
  const isFollowingOutputRef = useRef(true);
  const prevThreadKeyRef = useRef<string | null>(null);
  const prevScrollToTurnIdRef = useRef<string | undefined>(undefined);
  const initialScrolledRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Track previous streaming state to detect transition
  const prevIsStreamingRef = useRef(false);

  // Reset state when THREAD changes (content gating for thread switch)
  useEffect(() => {
    if (prevThreadKeyRef.current === threadResetKey) return;
    prevThreadKeyRef.current = threadResetKey;
    initialScrolledRef.current = false;
    isFollowingOutputRef.current = true;
    // Hide content during thread switch to prevent flash at wrong scroll position
    // Using queueMicrotask avoids synchronous setState within effect body
    queueMicrotask(() => {
      setIsAtBottom(true);
      setIsContentReady(false);
    });
  }, [threadResetKey]);

  // Calculate distance from bottom
  const distanceFromBottom = useCallback(() => {
    if (!scrollContainer) return Infinity;
    return (
      scrollContainer.scrollHeight -
      scrollContainer.scrollTop -
      scrollContainer.clientHeight
    );
  }, [scrollContainer]);

  // Initial scroll to bookmarked turn on thread load, then reveal content
  // This only runs when thread changes (initialScrolledRef is reset by thread effect)
  useEffect(() => {
    if (!scrollContainer) return;
    if (isLoading) return;
    if (initialScrolledRef.current) return;
    if (turnIds.length === 0) return;

    // Fallback: No specific turn to scroll to, but we have turns to display.
    // Immediately reveal content (no scroll needed for bookmarked position).
    if (!scrollToTurnId) {
      initialScrolledRef.current = true;
      queueMicrotask(() => setIsContentReady(true));
      return;
    }

    let cancelled = false;
    let frameId: number | null = null;

    const MAX_FRAMES = 240;
    let lastHeight = 0;
    let stableFrames = 0;
    let frames = 0;

    const tick = () => {
      if (cancelled || initialScrolledRef.current) return;
      frames += 1;

      const h = scrollContainer.scrollHeight;
      if (h !== lastHeight) {
        lastHeight = h;
        stableFrames = 0;
      } else {
        stableFrames += 1;
      }

      const turnElement = scrollContainer.querySelector<HTMLElement>(
        `[data-turn-id="${scrollToTurnId}"]`,
      );

      if (turnElement && stableFrames >= initialStableFrames) {
        const isLastTurn = turnIds[turnIds.length - 1] === scrollToTurnId;

        if (isLastTurn) {
          // Scroll to bottom for last turn
          scrollContainer.scrollTo({ top: scrollContainer.scrollHeight });
          isFollowingOutputRef.current = true;
        } else {
          // Scroll to specific turn
          turnElement.scrollIntoView({
            behavior: "auto",
            block: "end",
            inline: "nearest",
          });
          isFollowingOutputRef.current = false;
        }

        initialScrolledRef.current = true;
        // Track the turn we scrolled to for sibling navigation detection
        prevScrollToTurnIdRef.current = scrollToTurnId;
        queueMicrotask(() => setIsContentReady(true));
        return;
      }

      if (frames < MAX_FRAMES) {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (frameId != null) cancelAnimationFrame(frameId);
    };
  }, [
    threadResetKey,
    scrollContainer,
    isLoading,
    scrollToTurnId,
    turnIds,
    initialStableFrames,
  ]);

  // Sibling navigation: scroll to new turn WITHOUT hiding content
  // Only runs after initial scroll is complete and when scrollToTurnId changes
  // Uses same layout stability pattern as initial scroll to avoid jumping
  useEffect(() => {
    // Skip if initial scroll hasn't happened yet (thread is still loading)
    if (!initialScrolledRef.current) return;
    // Skip if scrollToTurnId is unchanged
    if (prevScrollToTurnIdRef.current === scrollToTurnId) return;
    // Skip if no scroll target
    if (!scrollToTurnId) return;
    if (!scrollContainer) return;

    prevScrollToTurnIdRef.current = scrollToTurnId;

    // Wait for layout stability before scrolling (same pattern as initial scroll)
    let cancelled = false;
    let frameId: number | null = null;
    let lastHeight = 0;
    let stableFrames = 0;
    let frames = 0;
    const MAX_FRAMES = 60; // Less than initial (240) since content mostly exists

    const tick = () => {
      if (cancelled) return;
      frames += 1;

      const h = scrollContainer.scrollHeight;
      if (h !== lastHeight) {
        lastHeight = h;
        stableFrames = 0;
      } else {
        stableFrames += 1;
      }

      const turnElement = scrollContainer.querySelector<HTMLElement>(
        `[data-turn-id="${scrollToTurnId}"]`,
      );

      if (turnElement && stableFrames >= initialStableFrames) {
        const isLastTurn = turnIds[turnIds.length - 1] === scrollToTurnId;
        if (isLastTurn) {
          scrollContainer.scrollTo({ top: scrollContainer.scrollHeight });
          isFollowingOutputRef.current = true;
        } else {
          turnElement.scrollIntoView({
            behavior: "auto",
            block: "start",
            inline: "nearest",
          });
          isFollowingOutputRef.current = false;
        }
        return;
      }

      if (frames < MAX_FRAMES) {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (frameId != null) cancelAnimationFrame(frameId);
    };
  }, [scrollContainer, scrollToTurnId, turnIds, initialStableFrames]);

  // Track scroll position to detect when user scrolls away from bottom
  useEffect(() => {
    if (!scrollContainer) return;

    const handleScroll = () => {
      const d = distanceFromBottom();
      const atBottom = d <= nearBottomThreshold;

      setIsAtBottom(atBottom);

      if (isStreaming) {
        // Resume following when user scrolls back to bottom during streaming
        if (atBottom && !isFollowingOutputRef.current) {
          isFollowingOutputRef.current = true;
          onScrollToBottom?.();
        }
        // Pause following when user scrolls up during streaming
        if (!atBottom && isFollowingOutputRef.current) {
          isFollowingOutputRef.current = false;
        }
      }
    };

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    // Initialize state
    handleScroll();

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [
    scrollContainer,
    isStreaming,
    distanceFromBottom,
    nearBottomThreshold,
    onScrollToBottom,
  ]);

  // Auto-scroll during streaming when following output
  useEffect(() => {
    if (!isStreaming || !scrollContainer || !listRef.current) return;

    const observer = new ResizeObserver(() => {
      if (isFollowingOutputRef.current) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight });
      }
    });

    observer.observe(listRef.current);

    return () => {
      observer.disconnect();
    };
  }, [isStreaming, scrollContainer]);

  // Set follow state on transition to streaming (not during streaming)
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    // Only act on transition: not-streaming -> streaming
    if (isStreaming && !wasStreaming && scrollContainer) {
      // isAtBottom reflects pre-DOM-update position (scroll event hasn't fired yet
      // because scroll events fire on scrollTop changes, not scrollHeight changes)
      isFollowingOutputRef.current = isAtBottom;
      if (isAtBottom) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight });
      }
    }
  }, [isStreaming, isAtBottom, scrollContainer]);

  const scrollToBottom = useCallback(() => {
    if (!scrollContainer) return;
    // Instant scroll during streaming (content changing too fast for smooth)
    // Smooth scroll when not streaming (better UX for static content)
    const behavior = isStreaming ? "auto" : "smooth";
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    isFollowingOutputRef.current = true;
    setIsAtBottom(true);
    onScrollToBottom?.();
  }, [scrollContainer, isStreaming, onScrollToBottom]);

  // Show button when content is ready and not at bottom
  const isScrollable = scrollContainer
    ? scrollContainer.scrollHeight > scrollContainer.clientHeight
    : false;
  const showScrollButton = isContentReady && isScrollable && !isAtBottom;

  return { isContentReady, showScrollButton, scrollToBottom, listRef };
}
