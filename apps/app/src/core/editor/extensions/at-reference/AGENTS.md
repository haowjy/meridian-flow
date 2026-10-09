# extensions/at-reference — `@` in the Editor

Typing `@` in prose opens the reference browser
([`@/core/completion`](../../../completion/AGENTS.md)); choosing a document
writes a **standard Markdown link** to its address. `@` is how a writer types a
document link in the Editor: a typed `[[name]]` is plain text and opens nothing
(a pasted one becomes a link, which is [`../../links/`](../../links/AGENTS.md)'s
paste policy). The surface is `AtReferenceMenu` in
[`features/editor/surfaces/link/`](../../../../features/editor/surfaces/link/AGENTS.md).

## Key rules

- **A choice is a link that names its document.** `insertDocumentReference`
  writes `{ href: <full Context URI>, ref: doc:<id> }`: the row's id, never a
  parsed path, so the link follows the document through moves while every
  surface spells its current path. An uploaded picture goes in as an image with
  its `asset:` identity instead.
- **The Editor links ahead.** When a root search names no listed document
  exactly, the catalog's `linkAhead` adds one row that links
  `<holder folder>/<name>.md` (`linkAheadAddress`, the filename rule a follow's
  Create shares; `manuscript://<name>.md` from a holder with no address or in
  Scratch, Uploads, or Unfiled, which a link cannot create into). It
  inserts a link with a freshly minted ahead ref (`insertLinkAhead`, offline,
  at `aheadAddress`) and creates nothing: the chip is dashed until a document
  arrives at exactly that address (a follow's Create), which settles the ref.
- **The composer reuses this lane with its own insertion** (`insertReference`)
  and no `linkAhead`: a chat reference is identity-bearing and must name an
  existing document.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts) — the
  mechanism every lane shares
→ [`../../links/AGENTS.md`](../../links/AGENTS.md) — what a link means once it exists
