import { EditorView } from "@codemirror/view"

export const composerTheme = EditorView.theme({
  "&.cm-editor": {
    fontSize: "14px",
    fontFamily: "var(--font-sans)",
    outline: "none",
  },
  "&.cm-editor.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    padding: "5px 0",
    caretColor: "var(--foreground)",
    cursor: "text",
  },
  ".cm-scroller": {
    overflow: "auto",
    maxHeight: "200px",
  },
  ".cm-line": {
    lineHeight: "1.5",
    padding: "0",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--foreground)",
    borderLeftWidth: "1.5px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 15%, transparent)",
  },
  ".cm-placeholder": {
    color: "color-mix(in srgb, var(--muted-foreground) 60%, transparent)",
    fontStyle: "normal",
    display: "inline-block !important",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "top",
  },
})

export const composerInputMinHeight = EditorView.theme({
  ".cm-scroller": {
    minHeight: "48px",
  },
})
