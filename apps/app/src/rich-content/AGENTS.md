# rich-content

`Markdown` selects the presentation path. Markdown without reference or skill
occurrences uses `DocumentMarkdown`: the shared markup codec and a React
walker, with no editor instance. `styles/document.css` owns document typography,
block surfaces and lowlight colors for both chat and the manuscript. Chat retains
its smaller reading tier, with 8px between all top-level blocks (including headings)
and 4px between list rows. The manuscript retains its existing block rhythm.

Static and streaming use the same source-keyed memoized block components. Only the
live tail is repaired with remend and reparsed as tokens arrive. Blank lines outside
fences delimit conservative render units; loose list/quote/indented continuations
stay together. Reference-definition syntax and raw HTML outside fences retain whole-document parsing
because later source can change earlier blocks. Open-fence highlights are throttled
at 50ms; fresh text is always visible immediately. Settlement keeps the same DOM tree.
Bounded source caches retain settled PM trees and code colors across virtual-row
remounts (256 entries and 250,000 key characters each); live tails are not retained.

Source-authoritative reference/skill turns temporarily remain on Streamdown. Do not
approximate occurrence ranges with displayed-text matching or
add schema attributes for transcript-only presentation. Their migration needs the
codec source-position contract recorded in work item `thread-ux-2`.

The walker handles the Markdown codec's nodes, not MDX figure/JSX editing views.
Diagram fences remain source until the diagram integration phase. Copy-as-HTML
still has its existing pipeline in `features/chat/assistant-turn-copy.ts`.
