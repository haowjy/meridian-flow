# rich-content

`Markdown` renders through `DocumentMarkdown`: the shared markup codec and a React
walker, with no editor instance ([decision][chat-rendering]).

- Static and streaming text use the same block components and one document snapshot
  owner. Don't add a second parser, a blank-line splitter or inferred fence state.
- An open code fence stays code, even at settlement.

Worker protocol and writer occurrences:
[`.context/CONTEXT.md`](.context/CONTEXT.md).

[chat-rendering]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/chat/transcript.md
