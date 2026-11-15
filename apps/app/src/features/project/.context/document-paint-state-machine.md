# Held paint

What a document keeps painting once the draft it shows leaves its owner's list
(`useDocumentPaint` in `views.ts`). A Discard made elsewhere, or its document going to Trash,
takes the draft out of the list, but the page stays on it until the writer chooses another
version. The draft's own end is [Draft end and reopen](../../draft-review/.context/state-machines.md).

```mermaid
stateDiagram-v2
  [*] --> none
  none --> held: a listed draft is painted
  held --> held: the writer's choice is unchanged and the draft is listed again
  held --> asking: the draft left its list, and its end is not known yet
  asking --> trash: the draft ended in a way that stays on screen
  asking --> gone: the server answers it open (an Apply took its changes) or it ended otherwise
  held --> trash: the draft ended in a way that stays on screen
  trash --> held: a restore lists it again
  held --> none: the writer chose another version, or the document changed
  trash --> none: the writer chose another version
  gone --> none
```

- **`asking` paints the draft, not Live**: a draft that left its list is either in Trash (keep
  it) or open with nothing to show (let it go), and only the server says which. The page reads
  current metadata once (`fetchCurrentDraftMetadata`); `gone` closes it through the command
  owner, which then says whether it stays.
- **`held` is state, not a ref read during render**: the effect that follows the list sets it,
  and the next render paints from it.
- **The writer's choice ends the hold**: the key is the pin and the sidebar's Live/Draft choice
  when the draft was painted; any change to them drops it.
