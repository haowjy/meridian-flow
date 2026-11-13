# domains/storage — Object store

This domain stores opaque bytes behind `ObjectStorePort`. Callers persist
stable object URLs; renderers request short-lived read URLs, and no domain
meaning such as figures or attachments belongs here.

## Contract

`ObjectStorePort` exposes `put(key, bytes, mimeType)`, `get`, `getStream`, `copy`,
`readHead`, `signPut`, `getSignedUrl`, `list` and `delete`. Each returns an `ObjectStoreResult<T>` tagged `ok`
or `error`; the port does not throw. Errors use `invalid_key`, `not_found`,
`too_large`, or `io_error`.

A file can reach 200 MiB, so only a bounded read holds an object whole:

- `get(key, { maxBytes })` reads a whole object into memory and refuses (`too_large`)
  above the cap before reading, or when the store reports no length. Previews and
  model-sized images pass a cap. The import organizer calls `get` uncapped; it is bounded by
  the import size limit, so raise that limit only with a cap or a stream there.
- `getStream` is for the export, which pipes it into a zip entry; destroying the
  stream abandons the read.
- `copy(from, to)` duplicates inside the store (`CopyObject`, `copyFile`) and returns
  the copy's size and type. A failed copy leaves no object at `to`. Local copy and PUT write a temp file under
  `.tmp/`, append the object's metadata to it (an object is one file: bytes, metadata JSON,
  then the JSON's length as four bytes) and publish it with one rename, so a failed write or a
  crash leaves an existing object as it was, never bytes without metadata; temp files older than a day (crash leftovers) are cleared before the first write after a start.
- `list(prefix)` takes `""` or a key with an optional trailing `/`, and matches by plain string
  prefix, in every adapter (`isSafeKeyPrefix` in `object-key.ts`, with the key rule `isSafeKey`).
  Callers list `imports/<id>/`.
- `readHead(key, n)` answers the object's size and first `n` bytes without reading the
  rest; an empty object answers size 0 (S3 refuses a range read of one).
- `signPut(key, { sizeBytes, mimeType })` is a short-lived URL for a browser PUT of
  exactly that length and type; the store refuses any other. It needs no object to
  exist, and the URL can be used again: a second PUT replaces the object. So no row
  may point at a key a URL names (upload intake PUTs to `incoming/…` and copies).
  The result's `headers` are sent as given; the browser sets `Content-Length`. S3
  signs both as headers on the public-endpoint client, after making sure the bucket exists
  (`S3_CREATE_BUCKET_IF_MISSING` creates it once per process). Local signs them into the token and
  `PUT /api/object-store/local/<token>` (`writeSignedToken`) refuses a wrong length, a wrong
  type, an expired token and a read token, and replaces an existing object, as S3 does.
  A signed token authorizes writes, so production with `OBJECT_STORE_PROVIDER=local`
  requires a private `OBJECT_STORE_SIGNING_SECRET`.
  Node cuts a request whose body takes over 300 s to arrive (408), and a local PUT is such a
  request. `nitro dev` listens in its main thread, so `pnpm dev` preloads
  `apps/server/scripts/dev-request-timeout.mjs`, which raises the limit to an hour. A
  production server on the local provider keeps Node's 300 s; use S3 or R2 for uploads over a slow uplink.
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

Conversion runs in a two-worker `worker_threads` pool (`image-preview-worker.ts`; the pool is
`file-intake/worker-pool.ts`, the one every conversion uses), never on the event loop: libheif's WASM and `bmp-ts` are synchronous and froze the
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

Every delete of a stored object that may have a derived file, compensating deletes
included, goes through `ObjectRelease`, so a derived file never outlives its original.

## Derived files

A file is derived from an original and lives and dies with it. `derivedObjectKeys(key)`
(`object-storage-url.ts`) is the one list: today `previewObjectKey` (`.preview`) and
`textObjectKey` (`.text`). Release (`object-release.ts`), the binary copy
(`context/binary-copy.ts`) and the import sweep (`import/domain/object-sweep.ts`) all use it;
add a new derived file there and nowhere else.

A derived file is stored with `putDerivedObject` (`derived-object.ts`), which checks after the put
that the original still exists and deletes the derived file if not. Release deletes the original
first, then its derived keys, so a conversion that read the original before a release and puts
after it finds the original gone and removes its own file. Only a process crash between the put
and the check can leave one behind.

`.text` is the Markdown extracted from an EPUB or PDF, made by the first `read` that needs it
(`file-intake/text/extracted-text.ts`), not at upload. Finding it at that key is valid for good
because a stored file's bytes never change: an upload's key is `uploads/<project>/<doc>`, a copy
gets a new key, and nothing replaces an object in place. Keep that true (the sandbox's
read-write mounts included), or the cache serves stale text. Two first reads at once write the
same bytes, and every adapter's `put` is atomic.

Conversion limits (`file-intake/text/limits.ts`): an EPUB's entry count, each entry's declared
size and the total are checked from the zip's central directory before anything inflates, and only
XML and XHTML entries are inflated; XML that declares an entity is refused whole; XHTML goes
through the HTML5 parser, which has no DTD. Every conversion runs in a worker
(`file-intake/text/convert.ts`, `conversion-worker.ts`, the shared `worker-pool.ts`) that is
terminated at a 20 s deadline and capped at 512 MB of heap, so a hostile file can't freeze the
event loop or outlive its read; the output cap is 1,000,000 characters (the text says where it
was cut). A new converter is a new job kind there. `read` also counts a PDF's pages in that worker
(`countPdfPages`) and stores the count on the media part (`pageCount`), because whether a PDF goes
as media depends on it (`placeMedia`'s `pages`). No extracted text goes into a
log, event or error: refusals carry our own sentence.

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
