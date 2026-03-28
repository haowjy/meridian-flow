import type { Extension } from "@codemirror/state"

import { blockDecorations } from "./decorations/block-decorations"
import { blockquoteDecorations } from "./decorations/blockquote"
import { emphasisDecorations } from "./decorations/emphasis"
import { headingDecorations } from "./decorations/heading"
import { horizontalRuleDecorations } from "./decorations/horizontal-rule"
import { imageDecorations } from "./decorations/images"
import { inlineCodeDecorations } from "./decorations/inline-code"
import { linkDecorations } from "./decorations/links"
import { listDecorations } from "./decorations/lists"

export function livePreviewExtension(): Extension[] {
  // focusState, revealState, and focusTracker are included in Editor.tsx
  // and must NOT be duplicated here. focusTracker uses domEventHandlers
  // (not a StateField), so CM6 does not deduplicate it — including it
  // twice would fire blur/focus effects twice.
  return [
    headingDecorations(),
    emphasisDecorations(),
    linkDecorations(),
    blockquoteDecorations(),
    listDecorations(),
    horizontalRuleDecorations(),
    imageDecorations(),
    inlineCodeDecorations(),
    // Block-level decorations (fenced code + mermaid) via unified StateField.
    // Must be StateField (not ViewPlugin) because multi-line Decoration.replace
    // and block: true are forbidden in function-provided decorations.
    ...blockDecorations(),
  ]
}
