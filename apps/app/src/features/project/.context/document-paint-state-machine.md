# Held paint

What a document keeps painting once the draft it shows leaves its owner's list
(`useDocumentPaint` in `views.ts`). An Apply or Discard made elsewhere takes the draft out of the
list, and the page goes on to what is left.

```mermaid
stateDiagram-v2
  [*] --> none
  none --> held: a listed draft is painted
  held --> held: the writer's choice is unchanged and the draft is listed again
  held --> gone: the draft left its list, or a press holds it
  held --> none: the writer chose another version, or the document changed
  gone --> none
```

- **`held` is state, not a ref read during render**: the effect that follows the list sets it,
  and the next render paints from it.
- **The writer's choice ends the hold**: the key is the pin and the sidebar's Live/Draft choice
  when the draft was painted; any change to them drops it.
