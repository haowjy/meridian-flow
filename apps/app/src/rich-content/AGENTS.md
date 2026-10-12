# rich-content

`Markdown` selects the presentation path. Settled Markdown without reference or
skill occurrences uses `DocumentMarkdown`: the shared markup codec and a React
walker, with no editor instance. `styles/document.css` owns document typography,
block surfaces and lowlight colors for both chat and the manuscript. Chat retains
its reading tier and row rhythm; the manuscript retains its existing block rhythm.

Streaming and source-authoritative reference/skill turns temporarily remain on
Streamdown. Do not approximate occurrence ranges with displayed-text matching or
add schema attributes for transcript-only presentation. Their migration needs the
codec source-position contract recorded in work item `thread-ux-2`.

The walker handles the Markdown codec's nodes, not MDX figure/JSX editing views.
Diagram fences remain source until the diagram integration phase. Copy-as-HTML
still has its existing pipeline in `features/chat/assistant-turn-copy.ts`.
