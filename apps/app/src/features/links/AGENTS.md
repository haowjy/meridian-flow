# features/links — following an internal link

What a click on `[[Kael]]`, `manuscript://…`, or `./cast.md` does in any
surface that shows one: resolve it in that surface's scope, then open the
document or say what the follow found. Owned by neither the Editor nor chat.
What a link *means* (classification, the per-editor cache, the click decision)
is [`core/editor/links/`](../../core/editor/links/AGENTS.md); what a writer
*sees* is the calling surface's host.

## Mental model

A surface supplies three things, and everything between is here:

- **Scope** (`LinkResolutionScope`): project, Work, and the holder's base URI.
  Together with the index's revision, it is what an answer is true of. A
  surface that does not know its Work yet passes `"pending"`; a click waits for
  the real scope and is never answered from a guessed one.
- **Destination** (`LinkDestination`): an injected `open` callback. Each
  surface supplies its own; this module never decides where a document opens.
- **Host** (`FollowReporter` plus a dialog around `FollowOutcomeContent`): where
  checking, missing, ambiguous, and failed are said. The Editor's host is
  `EditorDialog` (`surfaces/link/FollowOutcomeDialog.tsx`), because its outcome
  can open 250ms late and the chrome kernel must know about it. A surface with
  no editor kernel uses `LinkFollowDialog`.

Two surfaces use this today: the Editor (`ProjectLinkRuntime`, over its
per-editor decoration cache) and chat (`features/chat/useChatLinkFollowing.ts`,
whose header holds chat's own rules, over a cache the chat owns and its
transcript draws chips from). Either way, what a link draws and what a click
finds come from the same cache.

`useLinkFollower` binds the three: it registers `createProjectLinkResolver` on
the surface's resolution cache once per scope and runs `followProjectLink` for
each click. `useLinkableDocuments` is the scope's local document index: the
`[[` menu's rows, a relative link's base, and the local answer that saves a
request. Its catalogs mirror the server's candidate set
(`linkable-catalog-scopes.ts`); change the two together.

## Key rules

- **An answer belongs to a scope, not to a href.** Register again whenever
  project, Work, base URI, or catalog revision changes; registering is the
  cache's only invalidation. A rename is a scope change: `[[Old Name]]` is
  spelled the same, and its old answer is now the wrong document.
- **No component invalidates the link cache.** A create or rename anywhere is a
  new catalog, and the catalog is what the scope is keyed on. A mutation that
  also pokes the resolution store is a second owner of the same rule.
- **One follow procedure.** A surface never calls `resolveDocumentLink` or
  reads the resolution cache to decide what a click does; only this module
  does. Whether a reference is a link at all is `follower.canFollow`, which
  depends on the target and base URI, never on loading. Destination policy
  stays out of this module: no `surface` switch, only the injected `open`.
- **An abort stops a follow before it opens, never during.** The destination
  takes no signal. A newer `current` follow aborts the previous one; `new-tab`
  follows are never aborted by a newer one.
- **A follow clears only what it reported.** Follows share one surface
  reporter, so the follower tracks which follow owns the shown outcome. Hosts
  act through `dismiss()` and `retry()` and never branch on the outcome's
  state.
- **A pending answer claims nothing.** A follow interrupts only after
  `CHECKING_DELAY_MS`, so a link already resolved for rendering just opens.
- **A failed request is not an unresolved link.** It says so on follow, with
  Try again. An unasked question (a relative link with no base yet) throws in
  the resolver rather than answering null.
- **Unresolved is a sentence, never a warning.** Linking ahead of writing is
  the job; a missing wikilink offers to create the document.
- **Create is only for a name nothing carries.** An address that misses says
  so, and a name several documents carry lists them; neither offers Create,
  which would add a document the link still could not tell apart.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md): scope contracts, what a follow
  does per answer, create-on-miss, and the document index
