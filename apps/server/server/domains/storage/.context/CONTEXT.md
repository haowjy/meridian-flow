# domains/storage — Object store

This domain stores opaque bytes behind `ObjectStorePort`. Callers persist
stable object URLs; renderers request short-lived read URLs, and no domain
meaning such as figures or attachments belongs here.

## Contract

`ObjectStorePort` exposes `put(key, bytes, mimeType)`, `get`, `getStream`, `copy`,
`readHead`, `signPut`, `getSignedUrl`, `list` and `delete`. Each returns an `ObjectStoreResult<T>` tagged `ok`
or `error`; the port does not throw. Errors use `invalid_key`, `not_found`,
`too_large`, or `io_error`.

A file can reach 200 MiB, so nothing outside a bounded read holds an object whole:

- `get(key, { maxBytes })` reads a whole object into memory and refuses (`too_large`)
  above the cap before reading. Only previews and model-sized images use it.
- `getStream` is for the export, which pipes it into a zip entry; destroying the
  stream abandons the read.
- `copy(from, to)` duplicates inside the store (`CopyObject`, `copyFile`) and returns
  the copy's size and type. A failed copy leaves no object at `to`. Local copy and PUT write a temp file under
  `.tmp/` and rename it with its metadata, so a failed write leaves an existing object as
  it was; temp files older than a day (crash leftovers) are cleared before the first write after a start.
- `readHead(key, n)` answers the object's size and first `n` bytes without reading the
  rest; an empty object answers size 0 (S3 refuses a range read of one).
- `signPut(key, { sizeBytes, mimeType })` is a short-lived URL for a browser PUT of
  exactly that length and type; the store refuses any other. It needs no object to
  exist, and the URL can be used again: a second PUT replaces the object. So no row
  may point at a key a URL names (upload intake PUTs to `incoming/…` and copies).
  The result's `headers` are sent as given; the browser sets `Content-Length`. S3
  signs both as headers on the public-endpoint client. Local signs them into the token and
  `PUT /api/object-store/local/<token>` (`writeSignedToken`) refuses a wrong length, a wrong
  type, an expired token and a read token, and replaces an existing object, as S3 does.
  A signed token authorizes writes, so production with `OBJECT_STORE_PROVIDER=local`
  requires a private `OBJECT_STORE_SIGNING_SECRET`.
- `getSignedUrl(key, { contentDisposition })` lets a download carry its filename. S3
  signs it as `ResponseContentDisposition`; the local token carries it inside the
  signed payload, so the link can't be re-pointed at another name.

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
HEVC), `bmp-ts`. EMF, WMF, ICO and PSD have no decoder; `makeImagePreview`
returns null for them without trying, so they stay cards and log nothing. Files
saved before previews existed have none and show the card; nothing generates
one later.

Conversion runs in a two-worker `worker_threads` pool (`image-preview-worker.ts`),
never on the event loop: libheif's WASM and `bmp-ts` are synchronous and froze the
server for seconds per photo. The worker reads HEIC and BMP dimensions before
decoding and refuses an image over 50 MP (a phone photo fits; at the cap a
BMP peaks near 360 MB RSS per worker). A worker that crashes, runs out of memory
or hangs for 60 s is replaced and its file gets the card; a worker that fails a
HEIC decode is also replaced, since libheif's WASM may be left unusable. A
failed preview logs `image_preview.failed` with a `reason` code
(`worker_unavailable`, `timeout`, `decode_failed`, `too_large`), never a decoder
message. An import request queues at most two previews at a time, so one import
doesn't starve other writers' previews. `image-preview.ts` starts the worker with
`new URL("./image-preview-worker.ts", import.meta.url)`; `bundleWorkerEntries` in
`nitro.config.ts` (the plugin every worker entry shares) emits it as
`workers/image-preview-worker.mjs` and rewrites the URL, in `nitro dev` and in a build alike.
Nitro traces
`sharp`, `heic-decode`, `libheif-js` and `bmp-ts` as external packages.

Every delete of a stored object that may have a preview, compensating deletes
included, goes through `ObjectRelease`, so a key's preview never outlives it.

## Adapters and composition

Production selects `local` or `s3` from `OBJECT_STORE_PROVIDER`; tests use the
in-memory adapter. Local files use HMAC-signed tokens, S3 uses presigned GET
URLs, and the provider choice is made in `lib/compose.ts`, never in domain
code. The local signed-token route receives a separate local-adapter handle;
the injected domain port remains provider-neutral.

The same S3 adapter path serves development and production; only endpoint and
credentials differ. Dev bucket isolation belongs to `tools/dev`, not this
domain.

## Contracts

- Storage URLs are durable; signed URLs are ephemeral.
- This module knows keys, bytes, and MIME types only.
- Callers handle `ObjectStoreError` explicitly at the result boundary.
