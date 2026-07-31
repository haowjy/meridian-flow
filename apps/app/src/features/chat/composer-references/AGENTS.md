# features/chat/composer-references — `@` in the composer's textarea

A thin host, and deliberately nothing more. What a query means is
[`core/references`](../../../core/references/AGENTS.md); what an open menu does
with a key is [`core/completion`](../../../core/completion/AGENTS.md); the rows
are [`components/app/SuggestionList`](../../../components/app/SuggestionList.tsx),
the same list the manuscript renders. This directory owns the three things a
`<textarea>` has to answer for itself: where the token is, where the caret is
on screen, and what a pick leaves in the string.

## Mental model

**The message stays a plain string.** A pick splices `[[Title]]` into the text
and nothing structural rides beside it. The dialect card already teaches that
spelling, the transcript renders it as a link, and the agent reads the chapter
through the tools it already has. A shared title is the one exception: the
resolver would refuse both documents, so the pick spells the canonical URI the
row was already carrying.

**An open menu owns its keys, and the composer asks first.** ArrowUp,
ArrowDown, Enter and Escape belong to the menu while it has rows; a closed one
claims nothing. There is no chrome kernel under a textarea, so `Composer`
enforces the precedence itself with one call at the top of `handleKeyDown` —
otherwise picking a chapter would also post the half-typed question.

**The caret is measured, not known.** A textarea reports no geometry for a
position inside it, so `caret-anchor.ts` re-draws the text in an invisible
mirror and reads where the marker lands. It can fail, and the answer then is
the composer frame's top edge: degraded placement is the contract, a missing
menu is not.

**The visual viewport is the frame, not the layout one.** The composer sits
under a phone keyboard, and only `visualViewport` knows the keyboard exists.
That is why the menu places itself instead of going through a popper, and why
it opens upward into the transcript.

## Key rules

- **No matching or ranking here.** A filter written in this directory is a
  second menu that disagrees with `[[` about one query.
- **No create row.** The engine offers one; the composer drops it. A row
  promising to create a page from the chat box would either lie or do something
  the writer did not ask for. The empty list that leaves then closes the menu,
  which is the same law that leaves a writer alone with an unmatched `@`.
- **Re-measure on anything that reflows the text**: input, selection, the
  textarea's own scroll, a window or visual-viewport resize, a webfont
  arriving. A stale rect is a menu pointing at where the caret used to be.
- **Nothing in the menu takes focus.** The caret stays in the textarea or the
  next keystroke stops filtering.

## Anti-patterns

- Reaching for the editor to open a menu. Everything shared already lives under
  `core/` or `components/`.
- A second spelling for a picked document. `referenceSpelling` is the one
  answer, and it is tested where it lives.

→ [`../../../core/references/AGENTS.md`](../../../core/references/AGENTS.md) —
  the ranking, and the trigger's three functions over a string
→ [`../../project/context/useReferenceCandidates.ts`](../../project/context/useReferenceCandidates.ts) —
  where the rows come from
