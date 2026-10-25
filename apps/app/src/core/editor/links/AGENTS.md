# core/editor/links — headless link policy

This directory classifies, follows, renders, and assigns standard Markdown
links. Feature surfaces and the project resolver are adapters; this directory
does not render React or own navigation.

## Mental model

`classifyLinkTarget` is the one answer for Context URI, relative path, and
external URL. Click intent, hover hints, menus, mark rendering, sanitization,
clipboard, and paste all consume it. `linkClickIntent` decides follow versus
caret; `followLink` delegates external and internal destinations to registered
adapters. A missing navigator is a real refusal, not an alternate resolver.

The mark stores address and an optional `doc:`, `asset:`, ahead, or `folder:`
ref. Resolution is live cache data,
never document state. `linkChip` maps target and resolution to filled or dashed
appearance; chip styling and icons belong to the shared component.

## Rules

- Keep internal links as `{ ref, href }` with the classifier's canonical
  spelling. Standard Markdown links are the stored form; typed `[[name]]` is
  text. Editor paste may convert wikilinks through one transform, but chat and
  stored text do not.
- A new link spelling is added to `classifyLinkTarget` and nowhere else; a
  consumer that pattern-matches an href itself is the drift this module exists
  to prevent. The classifier is also the security fence: an href outside both
  families is `null`, meaning no hint, no follow, no Open verb, and no rendered
  destination. `MeridianLink` asks on parse, command, and render, because the
  Markdown parser is a third door into the document.
- A picture whose source is a document address (with a ref or without) is
  answered by this same resolution cache under the same key, never a second one.
  Link and picture views are the only askers: each mounted view watches its key
  and releases it on destruction, so a page of links is one batch. No document
  scan and no answer-only transaction.
- Unresolved is a state, not an error: serial writers link chapters before they
  write them. Addresses are unique, so there is no "several documents" state.
  A move writes nothing into linking documents.
- Gating an AI write on link validity is wrong: marks inform, nothing approves.
- Never navigate from a browser event or allow TipTap's link extension to do so.
  The editor click seam prevents native navigation and places the caret when
  follow is not chosen. External follow opens a new tab through the adapter.
- Resolution requests are generation-scoped. A new catalog scope, project, or
  account invalidates prior answers; stale responses cannot publish. Each
  requester owns its subscription and aborts on dispose.
- Pending, unresolved, failed, and missing-at-address are distinct outcomes.
  Missing internal addresses draw dashed and may offer create-at-exact-address;
  unresolved or failed answers must not be rewritten as absent.
- Create-on-miss uses the exact link address and then re-resolves. It never
  creates from a parsed label, guessed folder, or a stale href.
- A folder link (`folder:<id>`, href ending in `/`) is a link to the folder,
  not a document. Following it opens the folder surface (`openFolder`), never
  the document navigator. Every href is spelled through `storedHref` with the
  address's `kind`, so a folder keeps its trailing `/`.
- Clipboard assignment preserves kept identity only when the sanitizer proves
  it. Otherwise one assignment pass binds links from the destination catalog;
  resolver answers and capability metadata never enter the document.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — generation, clipboard, and
  behavior matrices
→ [`../extensions/at-reference/AGENTS.md`](../extensions/at-reference/AGENTS.md)
  — `@` insertion
→ [`../../../features/links/AGENTS.md`](../../../features/links/AGENTS.md) — follow adapter
