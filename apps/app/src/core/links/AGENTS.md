# core/links — what an href means, and what it points at right now

The link primitive, with no editor in it: a classifier that reads an href, and
an href-keyed store that holds what the project answered about one. Both the
manuscript and the chat transcript ask these two questions, so neither can
live in the lane that asked first.

## Mental model

**One vocabulary, two directions.** `classifyLinkTarget` reads an href already
written — by the parser, by an LLM, by a pick — and says which of the four
spellings it is. `normalizeLinkHref` reads what a writer typed and says what to
store. They share the scheme fence, which is why a scheme is added in one place
and the two answers cannot drift.

**Resolution is per-request and never persisted.** `[[The Second Gate]]` names
a document or it does not, and that is a fact about the project this minute
rather than about the mark. Unresolved is a rendered state and not an error:
serial writers link chapters before they write them. A FAILED request caches
nothing, because a link nobody could ask about must never draw as one that does
not exist.

**A registration is a generation.** Re-registering the port drops every answer
and every question the last one had out. That is the whole invalidation
mechanism — there is no second verb, and no mutation site has to poke a cache.

**An instance belongs to a scope.** The store keys by href, and `./cast.md`
means different documents in different documents, so a surface that can hold
relative links owns its own store rather than sharing one app-wide. What is
shared is the module.

## Key rules

- **No ProseMirror, no React, no DOM.** Anything that reads a document belongs
  in [`../editor/links/`](../editor/links/AGENTS.md); anything that renders one
  belongs in a surface.
- **The scheme sets live here, once.** A consumer that needs to know whether an
  href is internal asks the classifier. Forking the list is how the editor and
  the transcript start disagreeing about what `work://` is.
- **Null is two different answers, and they are not interchangeable.** The
  classifier's null is "not a link we act on"; the resolver's null is "nothing
  matched, or several did". A throw is the third: the question could not be
  asked.

## Anti-patterns

- Caching an answer across a scope change by hand. Register again.
- Reading `LinkResolution.read` to decide whether to offer a control. It
  answers null while no port is registered, which is a real state and not
  an absence.

→ [`../editor/links/AGENTS.md`](../editor/links/AGENTS.md) — the mark, the
  click, the surface store, the decoration that draws an answer
→ [`../references/AGENTS.md`](../references/AGENTS.md) — what a query may name,
  and what a pick spells
