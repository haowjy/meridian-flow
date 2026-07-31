# features/chat/composer-input — the composer's TipTap engine

The chat composer is a minimal TipTap input, not a textarea: `doc >
paragraph+`, inline content is text, a hard break, and one atomic
`referenceToken` node. No marks, no headings, no lists — a message box, not
the editor. `Composer.tsx` (sibling) is the surface; this directory owns the
schema, the `@` suggestion, the token, the menu popup, and the one
serialization the wire reads.

## Mental model

**Tokens own attachment state.** A pick from `@` — a document or a picture —
inserts an atomic `referenceToken`; it never splices text. The token carries
identity (`documentId`, `uri`) and its wire `spelling`, computed at pick time
(`[[Title]]`, or the canonical URI when the title is ambiguous; a picture is
always its canonical `manuscript://assets/…` URI). Backspace at
the token's boundary deletes the whole token, and that IS detach; a future
chip row is a derived view over `composerReferenceTokens(doc)`, never a
parallel store. Hand-typed `[[…]]` or `manuscript://…` stays plain text —
only picks create tokens (ruled; see the divergence record
[composer-tiptap-atomic-tokens](https://github.com/haowjy/meridian-flow-docs/blob/main/work/editor-toolbar-split/DIVERGENCE/composer-tiptap-atomic-tokens.md)).

**Serialization is the wire contract.** `onSubmit` still carries a plain
string: text verbatim, hard break → `\n`, paragraphs joined on `\n`, token →
its stored `spelling`. Beside it, and only when the draft holds picture
tokens, `composerImageBlocks(doc)` derives the message's image blocks
(`{ documentId, uri }`, one per distinct picture) — derived from token
presence at submit, never stored anywhere else. The token's spelling IS its
URI, which is what satisfies the server's image-URI-appears-in-text check by
construction. When the thread's model lacks `image_input`, `Composer.tsx`
shows a quiet hint under the draft; it informs and never gates the send.

**The `@` rides `@tiptap/suggestion`**, the same utility as the editor's
lanes, with the shared trigger envelope's word-boundary rule — but not
`createSuggestionLane`: the lane binds keys through the editor chrome kernel,
which the composer does not mount. The composer arbitrates its own keys in
`Composer.tsx`'s `handleKeyDown`, ahead of every plugin.

**What a query means is shared.** Ranking is `@/core/references`, menu state
is `@/core/completion`, rows are `components/app/SuggestionList`. The menu
places itself off `visualViewport` (phone keyboard) with the composer frame's
top edge as degraded anchor.

## Key rules

- **No matching or ranking here.** A filter written in this directory is a
  second menu that disagrees with `[[` about one query.
- **No create row.** A row promising to create a page from the chat box would
  either lie or do something the writer did not ask for.
- **Paste is plain text; copy is the serialization.** Both directions speak
  the wire's string. Pasted spellings stay plain text (no token revival).
- **The hard break is `hard_break`** (`MeridianHardBreak`), not TipTap's
  `hardBreak`, so the shared word-boundary predicate reads the composer as it
  reads the manuscript. Serialization matches on that name.
- **Design tokens only** in the pill; no raw hex, facts separated by layout
  (writer-copy ruling).

## Anti-patterns

- A second store for "what is attached". Token presence in the doc is the one
  truth; subscribe to it.
- Mounting editor chrome, Yjs, or the manuscript extension set here.
- Deciding `spelling` anywhere but pick time.

→ [`../../../core/references/AGENTS.md`](../../../core/references/AGENTS.md) —
  the ranking, and what a spelling means
→ [`../../../core/completion/AGENTS.md`](../../../core/completion/AGENTS.md) —
  what an open menu does with a key
