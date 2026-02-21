/**
 * Composer Editor
 *
 * Thin React wrapper around a CM6 EditorView for the thread composer.
 * The editor state is the source of truth for text + inline references.
 *
 * Exposes ComposerEditorRef for parent interaction:
 * - extractContent(): get clean text + references
 * - isEmpty(): check if editor has meaningful content
 * - focus(): focus the editor
 * - clear(): clear all content
 * - setContent(text): set plain text
 * - insertReference(data): programmatically insert an inline reference
 * - applyMention(atPos, cursorPos, data): replace @query with a reference pill
 */

import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import {
  EditorView,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import {
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { createMeridianClipboardExtension } from "@/core/clipboard/codemirrorExtension";
import {
  buildMeridianClipboardFromWikiText,
  meridianPayloadToWikiLinkText,
} from "@/core/editor/codemirror/wikiLinks";

import type { ContentBlock } from "@/features/threads/types";
import {
  inlineElementsField,
  inlineAtomicRanges,
  buildInitialState,
  ORC,
  type ReferenceElementData,
  insertInlineElement,
  addInlineElement,
  hasReference,
} from "./inlineElements";
import { contentBlocksToDocState } from "./contentBlocksToDocState";
import {
  buildComposerClipboardPayload,
  insertComposerClipboardPayload,
} from "./clipboardInterop";
import { extractContent, type ExtractedContent } from "./contentExtraction";
import { atMentionField, type AtMentionState } from "./atDetection";
import { composerTheme } from "./composerTheme";
import { createComposerKeymap } from "./composerKeymap";
import { getComposePlaceholder } from "./placeholders";

// =============================================================================
// REF TYPE
// =============================================================================

export interface ComposerEditorRef {
  /** Get clean text + references from the editor state */
  extractContent: () => ExtractedContent;
  /** Check if the editor has no meaningful content (ignoring whitespace) */
  isEmpty: () => boolean;
  /** Focus the editor */
  focus: () => void;
  /** Clear all content and inline elements */
  clear: () => void;
  /** Set plain text content (replaces everything) */
  setContent: (text: string) => void;
  /** Set content from ContentBlock[] — preserves interleaved text + reference pills */
  setContentWithBlocks: (blocks: ContentBlock[]) => void;
  /** Programmatically insert a reference at the current cursor position */
  insertReference: (data: ReferenceElementData) => void;
  /** Programmatically append a reference at the end of the document */
  appendReference: (data: ReferenceElementData) => void;
  /** Replace @query with a reference pill (used by the mention popover) */
  applyMention: (
    atPos: number,
    cursorPos: number,
    data: ReferenceElementData,
  ) => void;
  /** Get the EditorView (for advanced usage) */
  getView: () => EditorView | null;
}

// =============================================================================
// PROPS
// =============================================================================

interface ComposerEditorProps {
  /** Placeholder text shown when editor is empty */
  placeholder?: string;
  /** When this value changes, focus the editor */
  focusKey?: string | null;
  /** Called when the user presses Enter (submit) */
  onSubmit: () => void;
  /** Called when the user presses Escape */
  onEscape: () => void;
  /** Called when ArrowUp is pressed in an empty editor */
  onArrowUpEmpty: () => void;
  /** Called on any content change — used to update canSend in parent */
  onContentChange?: () => void;
  /** Called when user clicks a pill body (not the x button) — navigates to the referenced item */
  onPillClick?: (id: string, refType: string, pillEl: HTMLElement) => void;
  /** Called when @-mention pattern is detected or cleared */
  onAtMention?: (state: AtMentionState | null) => void;
  /** Whether mention popover is currently open */
  isPopoverOpen?: boolean;
  /** Additional CM6 extensions (e.g., compact theme override) */
  extraExtensions?: Extension[];
}

// =============================================================================
// COMPONENT
// =============================================================================

export const ComposerEditor = forwardRef<
  ComposerEditorRef,
  ComposerEditorProps
>(function ComposerEditor(
  {
    placeholder = getComposePlaceholder(null),
    focusKey,
    onSubmit,
    onEscape,
    onArrowUpEmpty,
    onContentChange,
    onPillClick,
    onAtMention,
    isPopoverOpen,
    extraExtensions,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const placeholderCompartment = useRef(new Compartment());
  const extraExtensionsRef = useRef(extraExtensions);

  // Store latest callbacks in refs to avoid recreating extensions
  const onSubmitRef = useRef(onSubmit);
  const onEscapeRef = useRef(onEscape);
  const onArrowUpEmptyRef = useRef(onArrowUpEmpty);
  const onContentChangeRef = useRef(onContentChange);
  const onPillClickRef = useRef(onPillClick);
  const onAtMentionRef = useRef(onAtMention);
  const isPopoverOpenRef = useRef(isPopoverOpen);

  onSubmitRef.current = onSubmit;
  onEscapeRef.current = onEscape;
  onArrowUpEmptyRef.current = onArrowUpEmpty;
  onContentChangeRef.current = onContentChange;
  onPillClickRef.current = onPillClick;
  onAtMentionRef.current = onAtMention;
  isPopoverOpenRef.current = isPopoverOpen;

  // Expose ref API
  useImperativeHandle(
    ref,
    () => ({
      extractContent: () => {
        const view = viewRef.current;
        if (!view) return { blocks: [], text: "", references: [] };
        return extractContent(view.state);
      },
      isEmpty: () => {
        const view = viewRef.current;
        if (!view) return true;
        // Strip \uFFFC and whitespace to check for meaningful content
        const text = view.state.doc.toString().replaceAll(ORC, "").trim();
        return text.length === 0;
      },
      focus: () => {
        viewRef.current?.focus();
      },
      clear: () => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
        });
      },
      setContent: (text: string) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
        });
      },
      setContentWithBlocks: (blocks: ContentBlock[]) => {
        const view = viewRef.current;
        if (!view) return;

        const { plainText, elements } = contentBlocksToDocState(blocks);

        const { text: docText, decorations } = buildInitialState(
          plainText,
          elements,
        );

        // Replace entire document and set decorations in one transaction
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: docText },
          effects: decorations.map((deco) =>
            addInlineElement.of({
              from: deco.from,
              to: deco.to,
              data: deco.value.spec.data as ReferenceElementData,
            }),
          ),
          selection: { anchor: docText.length },
        });
      },
      insertReference: (data: ReferenceElementData) => {
        const view = viewRef.current;
        if (!view) return;
        const pos = view.state.selection.main.head;
        insertInlineElement(view, pos, data);
      },
      appendReference: (data: ReferenceElementData) => {
        const view = viewRef.current;
        if (!view) return;
        // Skip if this document is already referenced
        if (hasReference(view.state, data.documentId)) return;

        const doc = view.state.doc.toString();
        const endPos = view.state.doc.length;
        const needsLeadingNewline =
          endPos > 0 && !/\s/.test(doc.charAt(endPos - 1));
        const leading = needsLeadingNewline ? "\n" : "";
        const insertAt = endPos + leading.length;
        if (leading) {
          view.dispatch({
            changes: { from: endPos, to: endPos, insert: leading },
            selection: { anchor: insertAt },
          });
        }
        insertInlineElement(view, insertAt, data);
      },
      applyMention: (
        atPos: number,
        cursorPos: number,
        data: ReferenceElementData,
      ) => {
        const view = viewRef.current;
        if (!view) return;
        // Skip if this document is already referenced
        if (hasReference(view.state, data.documentId)) return;
        insertInlineElement(view, atPos, data, cursorPos - atPos);
      },
      getView: () => viewRef.current,
    }),
    [],
  );

  // Create EditorView once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const state = EditorState.create({
      doc: "",
      extensions: [
        // Inline elements state + atomic ranges
        inlineElementsField,
        inlineAtomicRanges,

        // History (undo/redo)
        history(),
        keymap.of(historyKeymap),

        // Composer keymap (highest priority — Enter/Escape/ArrowUp)
        Prec.highest(
          keymap.of(
            createComposerKeymap({
              onSubmit: () => onSubmitRef.current(),
              onEscape: () => onEscapeRef.current(),
              onArrowUpEmpty: () => onArrowUpEmptyRef.current(),
              isPopoverOpen: () => isPopoverOpenRef.current ?? false,
            }),
          ),
        ),

        // Default keymap (basic editing: backspace, delete, etc.)
        keymap.of(defaultKeymap),

        // @-mention detection state (read by update listener below)
        atMentionField,

        // Theme (compact styling + pill CSS)
        composerTheme,

        // Caller-provided overrides (after base theme so they win)
        ...(extraExtensionsRef.current ?? []),

        // Line wrapping
        EditorView.lineWrapping,

        // Placeholder text (wrapped in compartment for dynamic updates)
        placeholderCompartment.current.of(placeholderExtension(placeholder)),

        // Paste filter: strip \uFFFC from pasted content to prevent orphaned placeholders
        EditorView.inputHandler.of((view, from, to, text) => {
          if (text.includes(ORC)) {
            const clean = text.replaceAll(ORC, "");
            view.dispatch({ changes: { from, to, insert: clean } });
            return true;
          }
          return false;
        }),

        // Clipboard interop for copy/cut/paste across composer + wiki-link surfaces
        createMeridianClipboardExtension({
          extractSelection(view, from, to) {
            const payload = buildComposerClipboardPayload(view.state, from, to);
            if (!payload) return null;
            return { payload };
          },
          insertPayload(view, payload, from, to) {
            return insertComposerClipboardPayload(view, payload, from, to);
          },
          toPlainTextFallback(payload) {
            return meridianPayloadToWikiLinkText(payload);
          },
          fromPlainTextFallback(text) {
            return buildMeridianClipboardFromWikiText(text);
          },
        }),
        EditorView.domEventHandlers({
          // Editable surface: edge clicks place caret, clear interior clicks open.
          mousedown(event, view) {
            if (event.button !== 0) return false;
            const target = event.target as HTMLElement;
            // Ignore clicks on the remove button (handled by its own onclick)
            if (target.closest("[data-action='remove']")) return false;
            const pill = target.closest(".ref-pill") as HTMLElement | null;
            if (!pill) return false;

            const pos = view.posAtDOM(pill, 0);
            if (pos >= 0) {
              const rect = pill.getBoundingClientRect();
              const edgeZonePx = 8;
              const distFromLeft = event.clientX - rect.left;
              const distFromRight = rect.right - event.clientX;
              const isLeftEdge = distFromLeft <= edgeZonePx;
              const isRightEdge = distFromRight <= edgeZonePx;

              if (isLeftEdge || isRightEdge) {
                view.dispatch({
                  selection: {
                    anchor: isLeftEdge
                      ? pos
                      : Math.min(pos + 1, view.state.doc.length),
                  },
                });
                view.focus();
                event.preventDefault();
                return true;
              }

              // Interior click: keep cursor stable (no selection move).
              // If a navigation callback exists, navigate to the referenced item.
              event.preventDefault();
              const documentId = pill.dataset.documentId;
              const refType = pill.dataset.refType ?? "document";
              if (documentId && onPillClickRef.current) {
                onPillClickRef.current(documentId, refType, pill);
              }
              return true;
            }
            return false;
          },
        }),

        // Unified update listener — bridges CM6 state changes to React callbacks.
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onContentChangeRef.current?.();
          }
          if (
            (update.docChanged || update.selectionSet) &&
            onAtMentionRef.current
          ) {
            const mentionState = update.state.field(atMentionField, false);
            onAtMentionRef.current(mentionState ?? null);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only create once — callbacks are in refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure placeholder when prop changes (e.g., after first @-mention use)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.current.reconfigure(
        placeholderExtension(placeholder),
      ),
    });
  }, [placeholder]);

  // Focus when focusKey changes
  useEffect(() => {
    if (!focusKey) return;
    requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      // Position cursor at end of content
      const len = view.state.doc.length;
      view.dispatch({ selection: { anchor: len } });
    });
  }, [focusKey]);

  return <div ref={containerRef} className="composer-editor" />;
});
