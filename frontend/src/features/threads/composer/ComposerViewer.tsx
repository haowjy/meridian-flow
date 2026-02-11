/**
 * Composer Viewer
 *
 * Read-only CM6 view that renders text + inline reference pills identically
 * to the editable composer. Used for displaying user turns in the thread.
 *
 * Accepts ContentBlock[] to preserve interleaved text/reference ordering.
 *
 * Reuses the same extensions (inlineElementsField, inlineAtomicRanges,
 * composerTheme) so pills look exactly the same as while typing.
 * No keybindings, no @-mention detection, no controls.
 */

import { useEffect, useRef } from "react";
import { Decoration, EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { createMeridianClipboardExtension } from "@/core/clipboard/codemirrorExtension";
import { meridianPayloadToWikiLinkText } from "@/core/editor/codemirror/wikiLinks";
import type { ContentBlock } from "@/features/threads/types";

import {
  inlineElementsField,
  inlineAtomicRanges,
  buildInitialState,
} from "./inlineElements";
import { composerTheme } from "./composerTheme";
import { buildComposerClipboardPayload } from "./clipboardInterop";
import { contentBlocksToDocState } from "./contentBlocksToDocState";

// =============================================================================
// PROPS
// =============================================================================

interface ComposerViewerProps {
  /** Ordered content blocks (text + references interleaved) */
  blocks: ContentBlock[];
  /** Called when user clicks a pill — navigates to the referenced item */
  onPillClick?: (id: string, refType: string, pillEl: HTMLElement) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ComposerViewer({ blocks, onPillClick }: ComposerViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onPillClickRef = useRef(onPillClick);
  useEffect(() => {
    onPillClickRef.current = onPillClick;
  }, [onPillClick]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { plainText, elements } = contentBlocksToDocState(blocks);
    const { text: docText, decorations } = buildInitialState(
      plainText,
      elements,
    );

    const state = EditorState.create({
      doc: docText,
      extensions: [
        // Pre-populate the decorations field with our reference pills
        inlineElementsField.init(() =>
          decorations.length > 0
            ? Decoration.set(decorations, true)
            : Decoration.none,
        ),
        inlineAtomicRanges,

        // Theme (pill CSS + read-only overrides)
        composerTheme,

        // Read-only — no editing, no cursor
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),

        // Line wrapping
        EditorView.lineWrapping,

        // Clipboard interop shared with editable composer and wiki-link editor
        createMeridianClipboardExtension({
          extractSelection(editorView, from, to) {
            const payload = buildComposerClipboardPayload(
              editorView.state,
              from,
              to,
            );
            if (!payload) return null;
            return { payload };
          },
          insertPayload() {
            return false;
          },
          toPlainTextFallback(payload) {
            return meridianPayloadToWikiLinkText(payload);
          },
          allowCut: false,
        }),
        EditorView.domEventHandlers({
          // Read-only surface: single-click opens the referenced document.
          mousedown(event) {
            const target = event.target as HTMLElement;
            if (target.closest(".ref-pill-remove")) return false;
            const pill = target.closest(
              ".ref-pill",
            ) as HTMLElement | null;
            if (!pill) return false;

            const documentId = pill.dataset.documentId;
            if (documentId) {
              event.preventDefault();
              const refType = pill.dataset.refType ?? "document";
              onPillClickRef.current?.(documentId, refType, pill);
              return true;
            }
            return false;
          },
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-create when content changes (turn data is immutable per render)
  }, [blocks]);

  return <div ref={containerRef} className="cm-read-only" />;
}
