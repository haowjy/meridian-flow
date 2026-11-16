# Image lifecycle contracts

The orphan sweep runs after the view update, not inside plugin `update`. It aborts
entries whose token is no longer present; a move isn't orphaning. On editor
destruction all entries abort and presence is released. A fenced session turns a
live entry into a retryable failure rather than writing. An insert refusal drops
the entry and presence field.

`ImageBytesPort` may return null for an ordinary CORS refusal, and that answer
creates no document write. Hosts register at runtime and absent hosts refuse
visibly.

A measured frame reserves the intrinsic box, including small icons; placeholder
minimums apply only without a measurement. Failed, abandoned or unresolved slots
give the measured frame and any stored width back so their message and controls
stay usable. A picture
that arrived without an upload is measured when it draws, so every drawn picture
has a frame. The frame is what lets the height cap narrow a stored width and keep
the ratio. The frame is itself a size container, so the cap is a registered
length that resolves to pixels at the prose root; `cqh` read inside a frame
would answer to the frame.

A pasted `data:` picture becomes a link first; import replaces that link only after
the bytes belong to the project. Refusal leaves the link and creates no hidden
asset. A pasted web picture, from any source and as HTML or Markdown, lands as a remote
picture (below) and is never imported. Raw `asset:` sources and arbitrary browser URLs
don't enter the document.

All source allow-listing and signed URL resolution sits in `inlinePictureSource`
and the asset render state.

**Remote pictures never load on their own.** A web address (`http(s)://`, `//`) that an
image, figure or Markdown image holds renders `RemoteImagePlaceholder`: the address and a
Load image button. The click asks `/api/image-proxy` (server fetch through the
public-address dispatcher; refusals carry a typed reason the placeholder words) and then
draws from the proxy URL, for the rest of the tab (`remote-image.ts`, nothing stored). The
page's `img-src` policy (`apps/app/src/server/content-security-policy.ts`) allows only
Flow's origin, the object store's signed-URL origin, `data:` and `blob:`, so an `<img>` that
bypasses the placeholder is refused by the browser. A new `<img>` fed from a document's
source goes through the placeholder or the asset render state, never a bare address. The
clipboard and drag HTML of a remote picture carries its address in `data-remote-src`, never in
`src`, because a serialized `<img src>` would be fetched (`pictureSourceAttributes` in
`meridian-extensions.ts`). The parse rule and the paste sanitizer read it back. Any other
pasted web picture (a foreign page's `<img src>`, the chat Copy button's HTML, Markdown
`![alt](address)`) also lands as the same remote picture: `linkExternalPastedImages` keeps
every web-address image and only `data:` images are imported. The address is therefore never
requested, by the browser or the proxy, until the writer clicks Load image.

## Size, cap and states

A drag that changes nothing on screen writes nothing, and a grip stops at the height
cap. A table-cell paragraph needs size containment before the picture can be capped
by its column. A very tall picture would push the writer's text out of view, hence
the cap. Clicking a picture the cap is holding back opens the viewer, as does the
object row's Open full screen. A phone keyboard shrinks the pane, so on touch screens
the cap holds through a height drop at the same width while the editor has focus
(`holdPictureCapThroughKeyboard`). The box narrows to keep the ratio, so the node
view needs the shape: an upload's frame, or the natural size once the picture draws.

Inline images use the same baseline and line-box behavior in prose and cells; a big
picture mid-sentence makes a tall line, up to the cap. A structural picture drop never
manufactures a table column. An unresolved stored source draws unavailable without
Retry, and a 404 from the signed-URL route draws gone. Renderers classify failures
through the render policy.
