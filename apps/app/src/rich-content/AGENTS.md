# rich-content

`Markdown` renders through `DocumentMarkdown`: the shared markup codec and a
React walker, with no editor instance ([decision][chat-rendering]). Chat and
the manuscript share one stylesheet, `styles/document.css`.

- Static and streaming text use the same block components and one document
  snapshot owner. Never add a second parser, a blank-line splitter or inferred
  fence state.
- Parsing runs in a module worker in the browser and synchronously for SSR,
  tests and worker failure; both paths give the same result.
- Reference identity comes from the codec's source map, never from matching
  displayed labels.
- An open code fence stays code, even at settlement.

Pipeline, caches, typography and shared Editor pieces:
[`.context/CONTEXT.md`](.context/CONTEXT.md).

[chat-rendering]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/chat-markdown-document-rendering.md
