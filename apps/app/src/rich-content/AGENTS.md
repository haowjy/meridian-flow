# rich-content — rendered markdown

Where a markdown string becomes what a reader sees: the chat transcript's
turns, tool output, helper summaries. A thin shell over Streamdown plus the two
things Meridian adds to it — streaming block collapse, and the internal
references a writer's message can carry.

## Mental model

**One `Markdown` component, and the styling is CSS.** Element treatment lives in
`globals.css` under `.prose-tokens`, not in a `components` override map. The map
carries exactly one entry, for an element markdown has no idea about.

**A reference is not a link, on the way through.** `[[The Third Gate]]` and
`manuscript://chapters/a.md` mean a project document, and the markdown
sanitizer would refuse both in an `href` — correctly, since neither is a URL a
browser can visit. So [`internal-references.ts`](internal-references.ts) emits
an element of ours carrying the target in a `data-` attribute, and
[`InternalReference`](InternalReference.tsx) resolves and follows it. Anchors
are left entirely alone, which is why an ordinary link in a message still
renders exactly as the library draws it.

**Resolution is somebody else's.** This directory renders a reference and asks a
runtime what is behind it; who can answer, and where a follow goes, is the
app's — mounted by
[`ProjectTranscriptReferences`](../features/project/chat/ProjectTranscriptReferences.tsx).
No runtime is a real state: outside a project every reference is plain prose.

## Key rules

- **Never fork the scheme list.** Which URIs address a document is
  [`@/core/links`](../core/links/AGENTS.md)'s answer, asked per string, so a
  scheme added there is read here the same day.
- **The sanitizer is a live constraint, not a formality.** It strips unlisted
  tags and attributes, refuses unknown `href` protocols, and rewrites `name`
  and `id` with a `user-content-` prefix. A new attribute has to be added to
  `allowedTags` by its *hast property* name and verified in the DOM.
- **Unresolved is quiet, and it is never a control.** The transcript does not
  offer to create a page a message named: a sent message is a record of what
  was asked.

## Anti-patterns

- Overriding the anchor renderer. Link safety, incomplete-link handling during
  streaming, and external-link styling all live in it.
- Resolving a reference from inside a renderer. The store is the app's, handed
  down as a runtime.

→ [`../core/links/AGENTS.md`](../core/links/AGENTS.md) — what an href means and
  what it points at
