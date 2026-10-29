# Saved file display

This recipe checks the named risk that a saved file shows as a broken image or a
Retry button instead of its content or a card with Download. Every saved file is
displayed: images browsers can't draw show a server-made preview, and anything
else shows a card.

## Setup

Use the lane's `pnpm dev` stack (restarted after `sharp`, `heic-decode` and
`bmp-ts` were installed) at 1440×900, in a throwaway project. Make these files in
a scratch directory outside the checkout:

- `map.tiff` (any TIFF, for example `sharp({create:{width:800,height:600,channels:3,background:'#c33'}}).tiff()`)
- `photo.heic` (a HEVC HEIC; libheif's `examples/example.heic` works)
- `plain.bmp` (a 24-bit BMP)
- `notes.pdf`, `thing.xyz` (a few random bytes) and `thesis.docx` containing an embedded TIFF
- `broken.tiff` (the first 200 bytes of `map.tiff`)

## Steps

1. Import all of them (drop on the Manuscript area or **Import…**). Each lands
   as a file. Open `map.tiff`, `photo.heic` and `plain.bmp`: the viewer shows the
   picture, and **Open original** in the footer downloads the original bytes.
2. Open `thing.xyz`, `broken.tiff` and `notes.pdf` in a browser with no PDF viewer
   (or any `.xyz`): each shows the card (name, type, size, **Download**). Download
   returns the exact original bytes. No tab says Retry.
3. Open the imported DOCX: its embedded TIFF draws inline from the preview. An
   embedded image the server couldn't convert shows the inline card, no Retry.
4. In a manuscript document, paste or drop `map.tiff`: it draws from the preview.
   Drop `broken.tiff`: the inline card appears after one automatic refresh.
5. Attach `map.tiff` to a chat with the paperclip and send. The server log shows
   the image sent as `image/webp`; the model describes it. With `broken.tiff` the
   image is left out with an `image.omitted` event, not sent as `image/tiff`.
6. Copy `map.tiff` (Copy to…): the copy opens with its preview; delete the
   original and the copy still draws.
7. Ask a Work to create `map.tiff`'s duplicate in a draft: the draft strip opens
   it in the preview dialog, a card for an undrawable file.
8. A file saved before previews existed (an older project) opens as the card.
9. With the network offline, open an image tab whose signed URL has expired:
   **Retry** appears only when the signed-URL request fails, and it recovers
   when the network returns.

10. On `pnpm dev` (a fresh start: the worker location comes from `nitro.config.ts`),
    import `map.tiff`, `plain.bmp` and `photo.heic`. `./mf api GET
    '/api/projects/<id>/context/kb/read?path=<folder>/map.tiff'` returns a
    `drawUrl` that differs from `url` (its key ends `.preview`), and `./mf log`
    shows no `image_preview.failed`. A `worker_unavailable` reason there means the
    worker file is not where `image-preview.ts` looks. Import `broken.tiff` and a
    truncated HEIC, then another good HEIC: the broken ones log `decode_failed`
    and the good one still gets its preview.

Record the commit, date and a screenshot of each state in the active work
item. Server-only checks without a restarted stack: `image-preview.test.ts` (a real
TIFF and BMP through the real worker) and the DB tests in `context/` and `import/`.
