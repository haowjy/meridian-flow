import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { Pencil, Trash2, ChevronDown } from "lucide-react";
import { useThreadStore } from "@/core/stores/useThreadStore";
import { useCurrentThreadStream } from "@/core/stores/useStreamStore";
import { useThreadPrefsStore } from "@/core/stores/useThreadPrefsStore";
import { useUIStore } from "@/core/stores/useUIStore";
import { usePillNavigation } from "@/shared/reference-pill";
import {
  ComposerShell,
  type ComposerShellRef,
  mentionResultToReferenceElementData,
  useMentionPopoverAnchor,
} from "@/features/threads/composer";
import type { AtMentionState } from "@/features/threads/composer/atDetection";
import type { ReferenceElementData } from "@/features/threads/composer/inlineElements";
import {
  DocumentMentionPopover,
  type MentionResult,
} from "@/features/threads/components/DocumentMentionPopover";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/lib/utils";
import { makeLogger } from "@/core/lib/logger";
import { ComposerAddContextButton } from "@/features/threads/components/ComposerAddContextButton";
import {
  getComposePlaceholder,
  getInterjectPlaceholder,
} from "@/features/threads/composer/placeholders";
import { composerInputMinHeight } from "@/features/threads/composer/composerTheme";
import { threadSurfacePadding } from "./styles";

const log = makeLogger("TurnInput");

interface TurnInputProps {
  threadId?: string; // Existing thread
  projectId?: string; // Cold start (no thread yet)
  /** When this value changes, focus the input. Parent controls timing, component handles mechanics. */
  focusKey?: string | null;
  /** Callback when composer height changes (for dynamic padding in parent) */
  onHeightChange?: (height: number) => void;
}

export function TurnInput({
  threadId,
  projectId,
  focusKey,
  onHeightChange,
}: TurnInputProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  // Track whether the editor has content (for canSend checks)
  const [hasContent, setHasContent] = useState(false);
  const [atMention, setAtMention] = useState<AtMentionState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerShellRef>(null);
  const collapsedPreviewRef = useRef<HTMLDivElement>(null);
  const expandedContentRef = useRef<HTMLDivElement>(null);

  // Measure and report height to parent for dynamic padding
  useLayoutEffect(() => {
    if (!containerRef.current || !onHeightChange) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        onHeightChange(entry.contentRect.height);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [onHeightChange]);

  // Thread preferences from dedicated store (persisted globally, session-aware)
  const { currentOptions, initOptionsForThread, updateOptionsManually } =
    useThreadPrefsStore();

  const { streamingTurnId } = useCurrentThreadStream();

  const {
    createTurn,
    startNewThread,
    isLoadingTurns,
    interruptStreamingTurn,
    submitInterjection,
    clearInterjection,
    interjectionContent,
  } = useThreadStore(
    useShallow((s) => ({
      createTurn: s.createTurn,
      startNewThread: s.startNewThread,
      isLoadingTurns: s.isLoadingTurns,
      interruptStreamingTurn: s.interruptStreamingTurn,
      submitInterjection: s.submitInterjection,
      clearInterjection: s.clearInterjection,
      interjectionContent: s.interjectionContent,
    })),
  );

  const { setActiveThread } = useUIStore(
    useShallow((s) => ({
      setActiveThread: s.setActiveThread,
    })),
  );
  const { pendingThreadReferences, clearPendingThreadReferences } = useUIStore(
    useShallow((s) => ({
      pendingThreadReferences: s.pendingThreadReferences,
      clearPendingThreadReferences: s.clearPendingThreadReferences,
    })),
  );

  const lastAtReferenceUsed = useUIStore((s) => s.lastAtReferenceUsed);

  // Get last turn's request params (for per-thread preference).
  // Selector returns a stable reference unless requestParams actually changes,
  // avoiding re-renders on high-frequency streaming deltas.
  const lastTurnParams = useThreadStore((s) => {
    for (let i = s.turnIds.length - 1; i >= 0; i--) {
      const id = s.turnIds[i];
      if (!id) continue;
      const t = s.turnById[id];
      if (t?.requestParams) return t.requestParams;
    }
    return null;
  });

  // Re-initialize options when thread changes or on mount
  // Store handles new-thread vs existing-thread logic internally
  useEffect(() => {
    initOptionsForThread(threadId, lastTurnParams);
  }, [threadId, lastTurnParams, initOptionsForThread]);

  // Detect if interjection content is truncated
  // Collapsed: check if line-clamp-2 truncates the text
  // Expanded: check if scrollable area has overflow
  useLayoutEffect(() => {
    const el = queueExpanded
      ? expandedContentRef.current
      : collapsedPreviewRef.current;
    if (!el) {
      setIsTruncated(false);
      return;
    }
    // Check if content overflows the visible area
    setIsTruncated(el.scrollHeight > el.clientHeight);
  }, [interjectionContent, queueExpanded]);

  // Main composer defaults to ~2 lines; edit/view surfaces stay content-sized.
  const inputMinHeightExtensions = useMemo(() => [composerInputMinHeight], []);

  const isStreaming = Boolean(streamingTurnId);

  // Can send a normal message if: has content, not loading, not submitting, not streaming, and has either threadId or projectId
  const canSendMessage =
    hasContent &&
    !isLoadingTurns &&
    !isSubmitting &&
    !isStreaming &&
    (Boolean(threadId) || Boolean(projectId));

  // Can send an interjection if: has content, not submitting, IS streaming, and has a streaming turn ID
  const canInterject =
    hasContent && !isSubmitting && isStreaming && Boolean(streamingTurnId);

  // Combined: can send either way
  const canSend = canSendMessage || canInterject;

  // Load interjection content into editor for editing
  // Clears from queue first (indicator disappears), then loads into editor
  const loadInterjectionForEdit = useCallback(async () => {
    if (!interjectionContent || !streamingTurnId) return;

    // Save content before clearing (it will be nulled after clear)
    const content = interjectionContent;
    log.debug("loadInterjectionForEdit", { contentLength: content.length });

    // Clear from queue first (API call) - indicator disappears
    await clearInterjection(streamingTurnId);

    // Now load into editor
    composerRef.current?.setContent(content);
    composerRef.current?.focus();
  }, [interjectionContent, streamingTurnId, clearInterjection]);

  // Clear queued interjection
  const handleClearInterjection = useCallback(async () => {
    if (streamingTurnId && interjectionContent) {
      log.debug("handleClearInterjection", { streamingTurnId });
      await clearInterjection(streamingTurnId);
    }
  }, [streamingTurnId, interjectionContent, clearInterjection]);

  // Send handler — extracts content from CM6 editor state
  const handleSend = useCallback(async () => {
    const composer = composerRef.current;
    if (!composer || composer.isEmpty()) return;

    const { blocks, text } = composer.extractContent();
    const messageText = text.trim();
    if (messageText.length === 0) return;

    // Clear editor immediately for responsiveness
    composer.clear();
    setHasContent(false);

    setIsSubmitting(true);
    try {
      if (isStreaming && streamingTurnId) {
        // Interjection flow - always 'append' since queue is cleared before editing
        // Note: interjections don't support references, just text
        log.debug("handleSend:interjection", {
          streamingTurnId,
          contentLength: messageText.length,
        });
        await submitInterjection(streamingTurnId, messageText, "append");
      } else if (threadId) {
        // Existing thread flow — pass ordered blocks preserving interleaving
        await createTurn(threadId, blocks, currentOptions);
      } else if (projectId) {
        // Cold start flow — creates thread atomically with ordered blocks
        const thread = await startNewThread(projectId, blocks, currentOptions);
        setActiveThread(thread.id);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [
    isStreaming,
    streamingTurnId,
    submitInterjection,
    threadId,
    createTurn,
    currentOptions,
    projectId,
    startNewThread,
    setActiveThread,
  ]);

  // Escape key handling (prioritized):
  // 1. If editor has content -> clear it
  // 2. Else if interjection queued -> clear it
  // 3. Else if streaming -> stop streaming
  const handleEscape = useCallback(() => {
    const composer = composerRef.current;
    if (composer && !composer.isEmpty()) {
      composer.clear();
      setHasContent(false);
    } else if (interjectionContent && streamingTurnId) {
      handleClearInterjection();
    } else if (isStreaming) {
      interruptStreamingTurn();
    }
  }, [
    interjectionContent,
    streamingTurnId,
    isStreaming,
    handleClearInterjection,
    interruptStreamingTurn,
  ]);

  // ArrowUp in empty editor -> load interjection for editing
  const handleArrowUpEmpty = useCallback(() => {
    if (interjectionContent && streamingTurnId) {
      loadInterjectionForEdit();
    }
  }, [interjectionContent, streamingTurnId, loadInterjectionForEdit]);

  const isPopoverOpen = atMention?.isActive ?? false;
  const getComposerView = useCallback(
    () => composerRef.current?.getView() ?? null,
    [],
  );
  const {
    anchorContainerRef: mentionAnchorContainerRef,
    mentionAnchor,
    floatingStyles: mentionFloatingStyles,
    setMentionReferenceRef,
    setMentionFloatingRef,
  } = useMentionPopoverAnchor({
    isOpen: isPopoverOpen,
    atMention,
    getView: getComposerView,
  });

  const handleAtMention = useCallback((state: AtMentionState | null) => {
    setAtMention(state);
  }, []);

  const handleMentionSelect = useCallback(
    (result: MentionResult) => {
      if (!atMention) return;
      const data = mentionResultToReferenceElementData(result);
      composerRef.current?.applyMention(
        atMention.atPos,
        atMention.cursorPos,
        data,
      );
      setAtMention(null);
      useUIStore.getState().recordAtReferenceUsage();
    },
    [atMention],
  );

  const handleMentionClose = useCallback(() => setAtMention(null), []);

  const handleAddReferences = useCallback((refs: ReferenceElementData[]) => {
    const composer = composerRef.current;
    if (!composer) return;
    for (const ref of refs) {
      composer.appendReference(ref);
    }
    composer.focus();
  }, []);

  // Consume queued references from non-composer UI (e.g., tree context menu)
  // and append them to the end of the current draft.
  useEffect(() => {
    if (pendingThreadReferences.length === 0) return;

    const composer = composerRef.current;
    if (!composer) return;

    for (const ref of pendingThreadReferences) {
      composer.appendReference({
        type: "reference",
        documentId: ref.documentId,
        refType: ref.refType,
        displayName: ref.displayName,
        documentPath: ref.documentPath,
      });
    }

    composer.focus();
    clearPendingThreadReferences();
  }, [pendingThreadReferences, clearPendingThreadReferences]);

  // Pill click → open documents in editor, folders in a popover
  const { handlePillClick, folderPopover } = usePillNavigation();

  // Show pending interjection content if present (received via SSE)
  // This visual indicator shows what's been queued server-side
  const showInterjectionIndicator = isStreaming && interjectionContent;

  // Unified layout for both mobile and desktop
  // Auto-expanding composer - editor grows up to max height, then scrolls internally
  return (
    <div ref={containerRef} className="thread-input-shell">
      <div className="mx-auto w-full max-w-3xl">
        {/* Queued interjection indicator - ABOVE composer, visually connected */}
        {/* Collapsed: 2-line preview, click anywhere to expand, icons centered */}
        {/* Expanded: full content inline (scrollable), only chevron collapses, icons at top */}
        {showInterjectionIndicator && (
          <div className="border-border/60 bg-muted mx-2 rounded-t-lg border border-b-0 py-0.5">
            {/* Single row layout - icons float to top when expanded */}
            <div
              className={cn(
                "flex gap-1 px-2 py-1.5",
                queueExpanded ? "items-start" : "items-center",
              )}
            >
              {/* Chevron - always clickable to toggle */}
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 [&_svg]:size-3"
                onClick={() => setQueueExpanded((v) => !v)}
                title={queueExpanded ? "Collapse" : "Expand"}
              >
                <ChevronDown
                  className={cn(
                    "transition-transform duration-150",
                    !queueExpanded && "rotate-180",
                  )}
                />
              </Button>

              {/* Content area - clickable only when collapsed, selectable when expanded */}
              <div
                onClick={
                  queueExpanded ? undefined : () => setQueueExpanded(true)
                }
                className={cn(
                  "relative min-w-0 flex-1",
                  !queueExpanded && "cursor-pointer",
                )}
                title={queueExpanded ? undefined : "Expand"}
              >
                <div
                  ref={queueExpanded ? expandedContentRef : collapsedPreviewRef}
                  className={cn(
                    "text-muted-foreground text-sm break-words whitespace-pre-wrap md:text-xs",
                    queueExpanded ? "max-h-24 overflow-y-auto" : "line-clamp-2",
                  )}
                >
                  {interjectionContent}
                </div>
                {/* Gradient fade indicates more content is hidden */}
                {isTruncated && (
                  <div className="from-muted/30 pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t to-transparent" />
                )}
              </div>

              {/* Action icons - float to top when expanded */}
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="[&_svg]:size-3"
                  onClick={loadInterjectionForEdit}
                  title="Edit"
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="[&_svg]:size-3"
                  onClick={handleClearInterjection}
                  title="Delete (Esc)"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          </div>
        )}
        <div
          className={cn(
            "border-border/60 bg-card focus-within:border-border flex flex-col border shadow-sm transition-shadow focus-within:shadow-md",
            showInterjectionIndicator ? "rounded-b-lg" : "rounded-lg",
          )}
          style={{ boxShadow: "var(--shadow-1)" }}
        >
          <div
            ref={mentionAnchorContainerRef}
            className={cn("relative", threadSurfacePadding)}
          >
            {isPopoverOpen && mentionAnchor && (
              <div
                ref={setMentionReferenceRef}
                className="pointer-events-none absolute size-px"
                style={{
                  left: `${mentionAnchor.x}px`,
                  top: `${mentionAnchor.y}px`,
                }}
                aria-hidden="true"
              />
            )}
            {isPopoverOpen &&
              mentionAnchor &&
              typeof document !== "undefined" &&
              createPortal(
                <div
                  ref={setMentionFloatingRef}
                  style={mentionFloatingStyles}
                  className="z-[70]"
                >
                  <DocumentMentionPopover
                    query={atMention?.query ?? ""}
                    isOpen={isPopoverOpen}
                    positioning="none"
                    onSelect={handleMentionSelect}
                    onClose={handleMentionClose}
                  />
                </div>,
                document.body,
              )}
            <ComposerShell
              ref={composerRef}
              focusKey={focusKey}
              extraExtensions={inputMinHeightExtensions}
              placeholder={
                isStreaming
                  ? getInterjectPlaceholder()
                  : getComposePlaceholder(lastAtReferenceUsed)
              }
              onSubmit={handleSend}
              onEscape={handleEscape}
              onArrowUpEmpty={handleArrowUpEmpty}
              onContentChange={setHasContent}
              onPillClick={handlePillClick}
              onAtMention={handleAtMention}
              isPopoverOpen={isPopoverOpen}
              options={currentOptions}
              onOptionsChange={updateOptionsManually}
              isSendDisabled={!canSend}
              isStreaming={isStreaming}
              onStop={interruptStreamingTurn}
              isInterjectionMode={isStreaming && hasContent}
              controlsRightContent={
                <ComposerAddContextButton
                  disabled={isStreaming}
                  onAddReferences={handleAddReferences}
                />
              }
            />
          </div>
        </div>
      </div>
      {folderPopover}
    </div>
  );
}
