# domains/storage — Object store

This domain stores opaque bytes behind `ObjectStorePort`. Callers persist
stable object URLs; renderers request short-lived read URLs, and no domain
meaning such as figures or attachments belongs here.

## Contract

`ObjectStorePort` exposes `put(key, bytes, mimeType)`, `getSignedUrl(key)`, and
`delete(key)`. Each returns an `ObjectStoreResult<T>` tagged `ok` or `error`;
the port does not throw. Errors use `invalid_key`, `not_found`, or `io_error`.

`object://meridian/<key>` is the stable persisted reference. The canonical
helpers `createObjectStorageUrl` and `objectStoreKeyFromStorageUrl` are its
only producers/consumers. Signed read URLs are temporary and are never
persisted.

Keys must match the safe-key grammar (`^[a-zA-Z0-9][a-zA-Z0-9/_:+=.,@-]*$`),
contain no empty or `..` segments, and remain under the local storage root.
Both adapters validate before I/O.

## Previews

An image browsers can't draw (TIFF, HEIC, BMP, ...) is stored as it arrived and
gets a browser-drawable WebP preview (longest side 2048 px) beside it at
`previewObjectKey(key)`: the original's key plus `.preview`. The key is derived,
so `ObjectRelease` deletes a preview with its original, the copy command copies
it, and the import sweep protects it, all without a stored reference. Whether
one exists is the document's `has_preview` (also on `context_staged_documents`
and the import receipt).

`saveImagePreview` (`file-intake/image-preview.ts`) is the one function that
makes and stores it; every save path calls it right after putting the original:
import receive and DOCX-image extraction, chat Uploads intake, pasted or dropped
figures. A copy duplicates the stored preview instead. It never throws: a file
with no preview is drawn as a file card. Decoders: `sharp` (TIFF and other
libvips formats), `heic-decode` (HEVC HEIC/HEIF; the bundled libvips has no
HEVC), `bmp-ts`. EMF/WMF have no maintained decoder and stay cards. Files saved
before previews existed have none and show the card; nothing generates one later.

## Adapters and composition

Production selects `local` or `s3` from `OBJECT_STORE_PROVIDER`; tests use the
in-memory adapter. Local files use HMAC-signed tokens, S3 uses presigned GET
URLs, and the provider choice is made in `lib/compose.ts`, never in domain
code. The local signed-token route receives a separate local-adapter handle;
the injected domain port remains provider-neutral.

The same S3 adapter path serves development and production; only endpoint and
credentials differ. Dev bucket isolation belongs to `tools/dev`, not this
domain.

## Invariants

- Storage URLs are durable; signed URLs are ephemeral.
- This module knows keys, bytes, and MIME types only.
- Callers handle `ObjectStoreError` explicitly at the result boundary.
