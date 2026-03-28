import { HighlightStyle } from "@codemirror/language"
import { tags } from "@lezer/highlight"

export const meridianMarkdownHighlightStyle = HighlightStyle.define([
  {
    tag: tags.heading,
    color: "var(--foreground)",
    fontWeight: "700",
    fontSize: "1.08em",
    letterSpacing: "0.01em",
  },
  {
    tag: tags.strong,
    fontWeight: "700",
  },
  {
    tag: tags.emphasis,
    fontStyle: "italic",
  },
  {
    tag: [tags.link, tags.url],
    color: "var(--accent-fill)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in oklab, var(--accent-fill) 45%, transparent)",
    textUnderlineOffset: "0.14em",
  },
  {
    tag: tags.monospace,
    color: "var(--foreground)",
    backgroundColor: "color-mix(in oklab, var(--foreground) 8%, transparent)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    borderRadius: "0.28em",
    padding: "0.04em 0.28em",
  },
  {
    tag: tags.quote,
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  {
    tag: [tags.list, tags.separator],
    color: "var(--foreground)",
    fontWeight: "400",
  },
])
