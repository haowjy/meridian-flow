import { useState, useEffect, useMemo, useRef, useCallback, } from "react";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react-dom";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { Card } from "@/shared/components/ui/card";
import { cn } from "@/lib/utils";
import { makeLogger } from "@/core/lib/logger";
import { openDocument } from "@/core/lib/panelHelpers";
import { userTurnCardBase } from "./styles";
import {
  ComposerShell,
  type ComposerShellRef,
} from "@/features/threads/composer";
import type { AtMentionState } from "@/features/threads/composer";
import type {
  ContentBlock,
  ThreadRequestOptions,
  RequestParams,
} from "@/features/threads/types";
import { requestParamsToOptions } from "@/features/threads/types";
import type { ReferenceElementData } from "@/features/threads/composer/inlineElements";
import { ComposerAddContextButton } from "@/features/threads/components/ComposerAddContextButton";
import {
  DocumentMentionPopover,
  type MentionResult,
} from "./DocumentMentionPopover";
import { useUIStore } from "@/core/stores/useUIStore";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { getEditPlaceholder } from "@/features/threads/composer/placeholders";
import { useIsMobile } from "@/core/hooks/useIsMobile";

const log = makeLogger("edit-turn-input");

interface EditTurnInputProps {
  isOpen: boolean;
  onClose: () => void;
  /** Ordered content blocks from the turn being edited */
  initialBlocks: ContentBlock[];
  /** Original request params from the turn being edited */
  originalRequestParams?: RequestParams | null;
  onSave: (
    blocks: ContentBlock[],
    options: ThreadRequestOptions,
  ) => Promise<void>;
  /** 1-based draft number among siblings (for placeholder text) */
  draftNumber: number;
  /** Total number of sibling drafts (for placeholder text) */
  totalDrafts: number;
}

export function EditTurnInput({
  isOpen,
  onClose,
  initialBlocks,
  originalRequestParams,
  onSave,
  draftNumber,
  totalDrafts,
}: EditTurnInputProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const lastAtReferenceUsed = useUIStore((s) => s.lastAtReferenceUsed);
  const [hasContent, setHasContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [atMention, setAtMention] = useState<AtMentionState | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const shellRef = useRef<ComposerShellRef>(null);
  const mentionAnchorContainerRef = useRef<HTMLDivElement>(null);

  const isPopoverOpen = !isMobile && (atMention?.isActive ?? false);
  const mentionCollisionPadding = {
    top: 64,
    right: 8,
    bottom: 8,
    left: 8,
  } as const;
  const {
    refs: mentionRefs,
    floatingStyles: mentionFloatingStyles,
    update: updateMentionPosition,
  } = useFloating({
    open: isPopoverOpen,
    strategy: "fixed",
    placement: "top-start",
    middleware: [
      offset(8),
      flip({
        fallbackPlacements: ["bottom-start"],
        padding: mentionCollisionPadding,
      }),
      shift({ padding: mentionCollisionPadding }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    if (!isPopoverOpen || !atMention) {
      setMentionAnchor(null);
      return;
    }

    const view = shellRef.current?.getView();
    const anchorContainer = mentionAnchorContainerRef.current;
    if (!view || !anchorContainer) {
      setMentionAnchor(null);
      return;
    }

    const coords = view.coordsAtPos(atMention.atPos);
    if (!coords) {
      setMentionAnchor(null);
      return;
    }

    const containerRect = anchorContainer.getBoundingClientRect();
    setMentionAnchor({
      x: coords.left - containerRect.left,
      y: coords.bottom - containerRect.top,
    });
  }, [isPopoverOpen, atMention]);

  useEffect(() => {
    if (!isPopoverOpen || !mentionAnchor) return;
    updateMentionPosition();
  }, [isPopoverOpen, mentionAnchor, atMention?.query, updateMentionPosition]);

  const setMentionReferenceRef = useCallback(
    (node: HTMLDivElement | null) => {
      mentionRefs.setReference(node);
    },
    [mentionRefs],
  );

  const setMentionFloatingRef = useCallback(
    (node: HTMLDivElement | null) => {
      mentionRefs.setFloating(node);
    },
    [mentionRefs],
  );

  const handleAtMention = useCallback((state: AtMentionState | null) => {
    setAtMention(state);
  }, []);

  const handleMentionSelect = useCallback(
    (result: MentionResult) => {
      if (!atMention) return;
      const data: ReferenceElementData = {
        type: "reference",
        documentId: result.id,
        refType: result.refType,
        displayName: result.name,
        documentPath: result.path,
      };
      shellRef.current?.applyMention(
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

  // Initialize options from original request params
  const initialOptions = useMemo(
    () => requestParamsToOptions(originalRequestParams),
    [originalRequestParams],
  );
  const [options, setOptions] = useState<ThreadRequestOptions>(initialOptions);

  // Load content blocks into CM6 editor when dialog opens
  useEffect(() => {
    if (isOpen) {
      setOptions(requestParamsToOptions(originalRequestParams));
      // Defer to next frame so the CM6 view is mounted
      requestAnimationFrame(() => {
        shellRef.current?.setContentWithBlocks(initialBlocks);
      });
    }
  }, [isOpen, initialBlocks, originalRequestParams]);

  const handleSave = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell || shell.isEmpty()) return;

    const { blocks, text } = shell.extractContent();
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    setIsSaving(true);
    try {
      await onSave(blocks, options);
      onClose();
    } catch (error) {
      log.error("Failed to save turn:", error);
    } finally {
      setIsSaving(false);
    }
  }, [onSave, options, onClose]);

  const handleAddReferences = useCallback((refs: ReferenceElementData[]) => {
    const shell = shellRef.current;
    if (!shell) return;
    for (const ref of refs) shell.appendReference(ref);
    shell.focus();
  }, []);

  const handlePillClick = useCallback(
    (documentId: string) => {
      const doc = useTreeStore
        .getState()
        .documents.find((d) => d.id === documentId);
      if (!doc) return;
      const projectSlug =
        useProjectStore.getState().currentProject()?.slug ?? "";
      if (!projectSlug) return;
      openDocument(doc.id, doc.path, projectSlug, navigate);
    },
    [navigate],
  );

  if (!isOpen) return null;

  // Card styling synced with UserTurn via userTurnCardBase
  // gap-2 overrides Card's gap-6, w-full for editor width
  return (
    <Card className={cn(userTurnCardBase, "w-full gap-2")}>
      <div ref={mentionAnchorContainerRef} className="relative">
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
          ref={shellRef}
          placeholder={getEditPlaceholder(draftNumber, totalDrafts, lastAtReferenceUsed)}
          focusKey={isOpen ? "edit" : null}
          onSubmit={handleSave}
          onEscape={onClose}
          onContentChange={setHasContent}
          onPillClick={handlePillClick}
          onAtMention={isMobile ? undefined : handleAtMention}
          isPopoverOpen={isPopoverOpen}
          options={options}
          onOptionsChange={setOptions}
          isSendDisabled={isSaving || !hasContent}
          saveIcon
          controlsRightContent={
            <ComposerAddContextButton
              disabled={isSaving}
              onAddReferences={handleAddReferences}
            />
          }
        />
      </div>
    </Card>
  );
}
