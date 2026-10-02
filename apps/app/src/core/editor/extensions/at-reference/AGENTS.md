# extensions/at-reference — `@` in the Editor

Typing `@` in prose opens the reference browser
([`@/core/completion`](../../../completion/AGENTS.md)); choosing a document
writes a **standard Markdown link** to its address. `@` is the only way a writer
inserts a document link in the Editor: `[[name]]` is plain text and opens
nothing. The surface is `AtReferenceMenu` in
[`features/editor/surfaces/link/`](../../../../features/editor/surfaces/link/AGENTS.md).

## Key rules

- **A choice is a link, spelled from the holder.** `insertDocumentLink` writes
  `spellDocumentHref(holderUri, uri)`: relative within the holder's area, a full
  Context URI across areas or from a holder with no address. An uploaded picture
  goes in as an image with its `asset:` identity instead.
- **The Editor links ahead.** When a root search names no listed document
  exactly, the catalog's `linkAhead` adds one row that links
  `<holder folder>/<name>.md` (`linkAheadAddress`, the filename rule a follow's
  Create shares; `manuscript://<name>.md` from a holder with no address). It
  inserts a link and creates nothing: the chip is dashed until a follow's Create
  makes the document at exactly that address.
- **A paste links `[[Name]]` from the same catalog.** The extension's
  `transformPasted` plugin turns each pasted `[[…]]` into a standard link to
  the document `linkTargets()` names, or a dashed `linkAhead` link
  ([`../../links/.context/CONTEXT.md`](../../links/.context/CONTEXT.md)).
- **The composer reuses this lane with its own insertion** (`insertReference`)
  and no `linkAhead`: a chat reference is identity-bearing and must name an
  existing document.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts) — the
  mechanism every lane shares
→ [`../../links/AGENTS.md`](../../links/AGENTS.md) — what a link means once it exists
