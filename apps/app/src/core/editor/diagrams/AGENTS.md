# core/editor/diagrams — which fences draw, and who draws them

A fenced diagram is a `code_block` the page renders instead of showing (§5.2:
the page never shows a diagram's syntax). This directory owns the catalog that
says which languages those are, the render state every one of them shares, and
the faces they wear. It owns no node view and no verb: the fence's node view is
[`../CodeBlockNodeView.tsx`](../CodeBlockNodeView.tsx), and the writer's verbs
belong to `features/editor/surfaces/objects`.

## Mental model

**A new diagram kind is one row plus its renderer.** The row in
`diagram-providers.ts` names the fence language, the name the writer's verbs use,
the starter source a fresh diagram opens on, and one async `render(id, source)`.
Everything downstream is generated or provider-neutral:

| Reads the catalog | Gets, for free |
|---|---|
| `../objects/object-types.ts` | one object registration per row: selection, arrow-walk, Esc, block drag, the greying context |
| `../CodeBlockNodeView.tsx` | render-or-source face, the three faces, the error card's door |
| `surfaces/objects` | the row's copy chip, the ⋮, Edit source, export, the lightbox |
| `surfaces/objects/fence-menu-items.tsx` | a language-menu entry, so a writer can turn a fence into one |
| `extensions/slash` | the Diagram entry, from the first row |

## Key rules

- **Nothing outside the catalog names a diagram language.** A predicate on
  `language === "mermaid"` anywhere else is the parallel hierarchy this module
  replaced. Ask `diagramProviderFor(node)` or read the object registration.
- **A renderer returns SVG markup or throws a message the writer can read.**
  The message is shown verbatim on the stale and unrendered faces, so it has to
  name the problem, not the stack.
- **A renderer draws in the manuscript's ink.** Read the design tokens at render
  time (`mermaid-theme.ts` is the worked example) rather than copying colors,
  or a theme switch leaves the diagram behind. `useDiagramRender` redraws on the
  palette; the markup is the renderer's to repaint.
- **Sanitize before returning.** The markup is inserted as HTML.
- **The render layer is keyed by provider** wherever it is mounted. Render state
  belongs to one provider, and a language change would otherwise hand the new
  one the old one's state. A language change is a document change, so remounting
  there is allowed where a selection-driven remount would break the fence's
  invariant.
- **This module never imports object physics.** The door out of the error card
  is a callback the node view supplies, which is what keeps the dependency one
  way: objects read the catalog, the catalog reads nothing of theirs.

## Anti-patterns

- A second render-state hook, debounce, or face model per provider. The pause,
  the out-of-order guard, the palette redraw, and the three faces are one
  answer for every diagram language.
- A per-provider preview selector. Exports find the rendered markup through
  `DIAGRAM_PREVIEW_SELECTOR`, which `DiagramBody` is the only writer of.
- Rendering source in the page. The one exception (a caret inside the fence)
  belongs to the node view.

→ [`../objects/AGENTS.md`](../objects/AGENTS.md) — the physics a row generates
→ [`../../../features/editor/surfaces/objects/AGENTS.md`](../../../features/editor/surfaces/objects/AGENTS.md)
  — the verbs a row is read for
→ design of record: `editor-toolbar-split/interaction-model.md` §5.2
