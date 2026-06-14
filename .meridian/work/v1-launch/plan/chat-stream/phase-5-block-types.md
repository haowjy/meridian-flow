# Phase 5: Image + Reference Block Renderers

## Scope
Add renderers for the two block types that need first-class UI treatment: images and references. Web search stays as a ToolItem — it already works through the tool abstraction and the backend classifies it as tool-related.

## Files to Create
- `frontend-v2/src/features/threads/components/ImageBlock.tsx` — Inline image renderer
- `frontend-v2/src/features/threads/components/ReferenceBlock.tsx` — Document reference renderer (linked mention pill)
- Stories for each

## Files to Modify
- `frontend-v2/src/features/threads/components/UserBubble.tsx` — Add image/reference rendering to block dispatch

## Block Renderers

### ImageBlock
Renders inline in user bubbles (user-uploaded images) or assistant turns (generated images, if ever).

```tsx
type ImageBlockProps = {
  url: string
  mimeType?: string
  altText?: string
}

function ImageBlock({ url, altText }: ImageBlockProps) {
  return (
    <img
      src={url}
      alt={altText ?? ""}
      className="max-w-full rounded-md"
      loading="lazy"
    />
  )
}
```

Backend block shape: `content: { url, mime_type, alt_text }`

### ReferenceBlock
Renders as a linked mention pill — click navigates to the referenced document/selection. Used in user turns when the user references a specific chapter or passage.

```tsx
type ReferenceBlockProps = {
  refId: string
  refType: string         // "document", "chapter", etc.
  displayText?: string    // resolved display name
  selectionStart?: number
  selectionEnd?: number
}

function ReferenceBlock({ displayText, refType }: ReferenceBlockProps) {
  return (
    <button className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-sm text-accent-text hover:bg-accent/20">
      <FileText className="size-3.5" />
      {displayText ?? `${refType} reference`}
    </button>
  )
}
```

Backend block shapes:
- `reference`: `content: { ref_id, ref_type, selection_start, selection_end }`
- `partial_reference`: same shape, selection offsets may be incomplete

### UserBubble block dispatch
```tsx
function UserBlock({ block }: { block: TurnBlock }) {
  switch (block.blockType) {
    case "text":
      return <p className="text-sm">{block.textContent}</p>
    case "image":
      return <ImageBlock url={block.content?.url} altText={block.content?.alt_text} />
    case "reference":
    case "partial_reference":
      return <ReferenceBlock refId={block.content?.ref_id} refType={block.content?.ref_type} displayText={block.content?.display_text} />
    case "tool_result":
      return null  // tool results in user turns are invisible (they're responses to assistant tool calls)
    default:
      return null
  }
}
```

## What's NOT in this phase
- **Web search** — stays as ToolItem, already has WebSearchDetail renderer
- **ActivityBlock changes** — images/references only appear in user turns (for now). ActivityBlock's `content | thinking | tool` dispatch is unchanged.
- **Click-to-navigate** on references — deferred until routing/editor integration exists

## Dependencies
- Requires: Phase 1 (TurnBlock type)
- Requires: Phase 2 (UserBubble component to extend)
- Independent of: Phases 3, 4

## Verification Criteria
- [ ] Images render inline in user bubbles with max-width constraint
- [ ] References render as styled pills with icon
- [ ] Partial references render same as references (just potentially incomplete selection)
- [ ] tool_result blocks in user turns render as nothing (invisible)
- [ ] Stories exist for UserBubble with text, images, references, and mixed content
- [ ] `pnpm exec tsc --noEmit` passes
- [ ] No changes to ActivityBlock or its item dispatch
