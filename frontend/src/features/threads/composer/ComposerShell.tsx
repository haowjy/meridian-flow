/**
 * ComposerShell
 *
 * Composable core that renders ComposerEditor + ThreadRequestControls with
 * shared plumbing. No outer container — parents wrap it in their own chrome.
 *
 * Used by TurnInput (main composer) and EditTurnInput (edit-in-place).
 */

import {
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
} from "react";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { ComposerEditor, type ComposerEditorRef } from "./ComposerEditor";
import type { AtMentionState } from "./atDetection";
import type { ExtractedContent } from "./contentExtraction";
import type { ReferenceElementData } from "./inlineElements";
import type { ContentBlock } from "@/features/threads/types";
import { ThreadRequestControls } from "@/features/threads/components/ThreadRequestControls";
import type { ThreadRequestOptions } from "@/features/threads/types";

// =============================================================================
// REF TYPE
// =============================================================================

export interface ComposerShellRef {
  extractContent: () => ExtractedContent;
  isEmpty: () => boolean;
  focus: () => void;
  clear: () => void;
  setContent: (text: string) => void;
  setContentWithBlocks: (blocks: ContentBlock[]) => void;
  insertReference: (data: ReferenceElementData) => void;
  appendReference: (data: ReferenceElementData) => void;
  applyMention: (
    atPos: number,
    cursorPos: number,
    data: ReferenceElementData,
  ) => void;
  getView: () => EditorView | null;
}

// =============================================================================
// PROPS
// =============================================================================

const noop = () => {};

export interface ComposerShellProps {
  // Editor behavior
  placeholder?: string;
  focusKey?: string | null;
  onSubmit: () => void;
  onEscape?: () => void;
  onArrowUpEmpty?: () => void;
  onPillClick?: (id: string, refType: string, pillEl: HTMLElement) => void;
  /** Additional CM6 extensions passed to the editor (e.g., compact theme) */
  extraExtensions?: Extension[];

  // Content tracking — parent uses this to compute canSend
  onContentChange?: (hasContent: boolean) => void;
  onAtMention?: (state: AtMentionState | null) => void;
  isPopoverOpen?: boolean;

  // Request controls (passthrough to ThreadRequestControls)
  options: ThreadRequestOptions;
  onOptionsChange: (options: ThreadRequestOptions) => void;
  isSendDisabled?: boolean;
  saveIcon?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  isInterjectionMode?: boolean;
  controlsRightContent?: ReactNode;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const ComposerShell = forwardRef<ComposerShellRef, ComposerShellProps>(
  function ComposerShell(
    {
      placeholder,
      focusKey,
      onSubmit,
      onEscape,
      onArrowUpEmpty,
      onPillClick,
      extraExtensions,
      onContentChange,
      onAtMention,
      isPopoverOpen,
      options,
      onOptionsChange,
      isSendDisabled,
      saveIcon,
      isStreaming,
      onStop,
      isInterjectionMode,
      controlsRightContent,
    },
    ref,
  ) {
    const editorRef = useRef<ComposerEditorRef>(null);

    // Passthrough ref — delegate everything to ComposerEditorRef
    useImperativeHandle(
      ref,
      () => ({
        extractContent: () =>
          editorRef.current?.extractContent() ?? {
            blocks: [],
            text: "",
            references: [],
          },
        isEmpty: () => editorRef.current?.isEmpty() ?? true,
        focus: () => editorRef.current?.focus(),
        clear: () => editorRef.current?.clear(),
        setContent: (text: string) => editorRef.current?.setContent(text),
        setContentWithBlocks: (blocks: ContentBlock[]) =>
          editorRef.current?.setContentWithBlocks(blocks),
        insertReference: (data: ReferenceElementData) =>
          editorRef.current?.insertReference(data),
        appendReference: (data: ReferenceElementData) =>
          editorRef.current?.appendReference(data),
        applyMention: (
          atPos: number,
          cursorPos: number,
          data: ReferenceElementData,
        ) => editorRef.current?.applyMention(atPos, cursorPos, data),
        getView: () => editorRef.current?.getView() ?? null,
      }),
      [],
    );

    // Bridge CM6's void callback to parent's boolean callback
    const handleContentChange = useCallback(() => {
      if (!onContentChange) return;
      const isEmpty = editorRef.current?.isEmpty() ?? true;
      onContentChange(!isEmpty);
    }, [onContentChange]);

    return (
      <>
        <ComposerEditor
          ref={editorRef}
          placeholder={placeholder}
          focusKey={focusKey}
          onSubmit={onSubmit}
          onEscape={onEscape ?? noop}
          onArrowUpEmpty={onArrowUpEmpty ?? noop}
          onContentChange={handleContentChange}
          onPillClick={onPillClick}
          onAtMention={onAtMention}
          isPopoverOpen={isPopoverOpen}
          extraExtensions={extraExtensions}
        />
        <ThreadRequestControls
          options={options}
          onOptionsChange={onOptionsChange}
          onSend={onSubmit}
          isSendDisabled={isSendDisabled}
          saveIcon={saveIcon}
          isStreaming={isStreaming}
          onStop={onStop}
          isInterjectionMode={isInterjectionMode}
          rightContent={controlsRightContent}
        />
      </>
    );
  },
);
