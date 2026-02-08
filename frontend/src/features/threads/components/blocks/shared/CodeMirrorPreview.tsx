/**
 * CodeMirrorPreview - Reusable read-only CodeMirror component
 *
 * Provides a read-only CodeMirror view with customizable line numbers and theme.
 * Handles CodeMirror lifecycle management (creation, updates, cleanup).
 *
 * Use cases:
 * - Document previews (TextEditorBlock view command)
 * - Code snippets in assistant messages (future)
 * - Search result previews (future)
 *
 * SRP: Single responsibility - CodeMirror lifecycle and rendering
 * OCP: Open for extension via props (startLine, extensions, className)
 */

import React, { useRef, useEffect } from "react";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, Extension } from "@codemirror/state";
import { cn } from "@/lib/utils";
import { markdownLanguage } from "@/core/editor/codemirror/extensions";

// =============================================================================
// TYPES
// =============================================================================

export interface CodeMirrorPreviewProps {
  /** Content to display (line number prefixes should be pre-stripped) */
  content: string;
  /** Starting line number for gutter (default: 1) */
  startLine?: number;
  /** Additional CSS classes for the container */
  className?: string;
  /** Additional CodeMirror extensions (appended after defaults) */
  extensions?: Extension[];
}

// =============================================================================
// THEME
// =============================================================================

/**
 * Read-only CodeMirror theme for document preview.
 * Minimal styling focused on readability in a compact preview area.
 */
const previewTheme = EditorView.theme({
  "&": {
    fontSize: "12px",
    fontFamily: "var(--font-mono)",
  },
  ".cm-content": {
    padding: "8px 4px",
  },
  ".cm-line": {
    lineHeight: "1.5",
  },
  // Line numbers styling
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid var(--theme-border, #e5e5e5)",
    color: "var(--theme-text-muted, #78716c)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 4px",
    minWidth: "32px",
  },
  // Markdown styling - simplified versions
  ".cm-strong": {
    fontWeight: "bold",
  },
  ".cm-em": {
    fontStyle: "italic",
  },
  ".cm-heading": {
    fontWeight: "bold",
  },
  ".cm-link": {
    color: "var(--theme-primary, #5F8575)",
    textDecoration: "underline",
  },
  ".cm-inline-code": {
    backgroundColor: "var(--theme-surface, #f5f5f5)",
    padding: "1px 4px",
    borderRadius: "2px",
  },
});

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Read-only CodeMirror preview with line numbers in gutter.
 * Content should have line number prefixes pre-stripped.
 */
export const CodeMirrorPreview = React.memo(function CodeMirrorPreview({
  content,
  startLine = 1,
  className,
  extensions: additionalExtensions = [],
}: CodeMirrorPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Create/update CodeMirror view
  useEffect(() => {
    if (!containerRef.current) return;

    // Create line numbers extension with custom start line
    const lineNumbersExt = lineNumbers({
      formatNumber: (n) => String(n + startLine - 1),
    });

    const extensions: Extension[] = [
      EditorView.editable.of(false), // Read-only
      EditorState.readOnly.of(true), // Fully read-only (no cursor)
      lineNumbersExt,
      markdownLanguage,
      previewTheme,
      EditorView.lineWrapping,
      ...additionalExtensions,
    ];

    // If view exists, update content
    if (viewRef.current) {
      const currentContent = viewRef.current.state.doc.toString();
      if (currentContent !== content) {
        viewRef.current.dispatch({
          changes: { from: 0, to: currentContent.length, insert: content },
        });
      }
      return;
    }

    // Create new view
    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [content, startLine, additionalExtensions]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "max-h-48 overflow-y-auto",
        "bg-muted/30 rounded-md border",
        "text-foreground/80",
        "[&_.cm-editor]:outline-none",
        className,
      )}
    />
  );
});
