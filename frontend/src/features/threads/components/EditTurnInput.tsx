import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/shared/components/ui/card";
import { cn } from "@/lib/utils";
import { makeLogger } from "@/core/lib/logger";
import { usePillNavigation } from "@/shared/reference-pill";
import { userTurnCardBase } from "./styles";
import {
  ComposerShell,
  type ComposerShellRef,
  mentionResultToReferenceElementData,
  useMentionPopoverAnchor,
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
  const isMobile = useIsMobile();
  const lastAtReferenceUsed = useUIStore((s) => s.lastAtReferenceUsed);
  const [hasContent, setHasContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [atMention, setAtMention] = useState<AtMentionState | null>(null);
  const shellRef = useRef<ComposerShellRef>(null);

  const isPopoverOpen = !isMobile && (atMention?.isActive ?? false);
  const getComposerView = useCallback(() => shellRef.current?.getView() ?? null, []);
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

  // Pill click → open documents in editor, folders in a popover
  const { handlePillClick, folderPopover } = usePillNavigation();

  if (!isOpen) return null;

  // Card styling synced with UserTurn via userTurnCardBase.
  // Compact gap keeps editor + controls aligned with main composer density.
  return (
    <Card className={cn(userTurnCardBase, "w-full gap-1.5")}>
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
          placeholder={getEditPlaceholder(
            draftNumber,
            totalDrafts,
            lastAtReferenceUsed,
          )}
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
      {folderPopover}
    </Card>
  );
}
