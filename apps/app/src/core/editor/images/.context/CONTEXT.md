# Image lifecycle contracts

This page covers image ingress mechanics that cross document, plugin, presence,
and project adapters. The document slot is authoritative; ephemeral state only
describes work in flight.

## Lifecycle

The sequence is: create token and plugin entry, publish this client's ownership,
insert the final image node with empty `src`, measure locally, upload through the
registered port, then settle the same node. The entry is opened before the node
is dispatched so peers never see a tokened slot without an owner. An insert
refusal drops the entry and presence field.

The orphan sweep runs after the view update, not inside plugin `update`. It
aborts entries whose token is no longer present; a move is not orphaning. On
editor destruction all entries abort and presence is released. A fenced session
turns a live entry into a retryable failure rather than writing.

`UploadedImage.src` is always an `asset:` identity. `ImageUploadPort` receives
the file, alt text, abort signal, and progress callback. `ImageBytesPort` may
return null for an ordinary CORS refusal; that answer does not create a
document write. Hosts register at runtime and absent hosts refuse visibly.

## Picker targets and history

`openImagePicker` accepts one of:

```ts
{ kind: "insert", at: EditorAnchor }
{ kind: "replace", slot: NodeHold }
```

After the file returns, the anchor must still accept an inline image or the hold
must still resolve to an image/figure surface. No selection fallback or search
for another location is allowed. Replace preserves the target's other attrs.

Insert landing is nonhistorical because the insertion itself is the writer's
event. Replace first clears the token nonhistorically, then writes `src` and
`alt` as one historical transaction. One undo therefore removes an inserted
picture or restores a replaced picture, respectively.

## Frames and resize

`width` is CSS pixels or null; null uses the file's intrinsic dimensions. Both
are capped by the prose column. A measured frame reserves the intrinsic box,
including small icons; placeholder minimums apply only without a measurement.
Failed, abandoned, or unresolved slots give the measured frame back so their
message and controls remain usable. In an auto-layout table, size containment on
the image-bearing cell paragraph gives the column a definite basis before the
picture's cap resolves.

Resize takes a `NodeHold`, measures the rendered box and narrowest visible
container, and previews width directly on the element. Release dispatches one
markup transaction preserving all attrs; cancellation restores the old style
and dispatches nothing. Grips follow the object-selection decoration and live
inside the node view, not a viewport overlay.

## Paste and identity

Clipboard handling restores a same-project asset identity when recorded metadata
proves it, otherwise assigns the recorded/current document address through the
link lane. Raw `asset:` sources and arbitrary browser URLs do not enter the
document. A pasted web picture becomes a link first; import replaces that link
only after bytes belong to the project. Refusal leaves the honest link and does
not create a hidden asset.

All source allow-listing and signed URL resolution is centralized in
`browserPictureSource` and the asset render state. A stale node view must not
retain the previous picture when its source changes.
