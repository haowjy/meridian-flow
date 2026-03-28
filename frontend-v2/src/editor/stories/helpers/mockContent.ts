/**
 * Sample markdown content for Storybook demos.
 *
 * All content uses fiction-writing themes: chapters, character sheets,
 * worldbuilding notes. Covers every markdown element the live preview renders.
 */

/** Full document exercising all decoration types */
export const fullDocument = `# Chapter 1: The Meridian Gate

## The Arrival

Elara stepped through the **brass archway** and into a world that smelled of *old paper* and ***impossible distances***. The gate hummed behind her, a sound like a tuning fork pressed against stone.

> "You can keep a secret or keep your sleep. You rarely keep both."
>
> > The ferryman's words echoed in the deeper chambers of her memory, layered beneath years of silence.

She carried three things:

- A compass that pointed to yesterday
  - Its needle was made of condensed moonlight
  - The casing was scratched but functional
- A letter sealed with black wax
- A name she wasn't supposed to know

Her instructions were precise:

1. Cross the threshold before the third bell
2. Find the cartographer's study
3. Do not look at the river

---

### The Cartographer's Study

The room was smaller than expected. Ink stains covered the desk like a map of their own, and the shelves held bottles of \`distilled starlight\` alongside ordinary quills.

She found the journal open to page 114:

\`\`\`
Entry 114: The tides shifted again.
The old channels are silting up.
New routes must be charted before winter.
\`\`\`

A diagram on the wall showed the network of passages:

\`\`\`mermaid
flowchart TD
    A[Meridian Gate] --> B{Fork}
    B -->|Left| C[River Passage]
    B -->|Right| D[Cartographer's Study]
    C --> E[Tidewater Basin]
    D --> F[Archive]
    F --> G[The Deep Library]
\`\`\`

#### Technical Notes

The cartographer had left a translation script:

\`\`\`typescript
interface Passage {
  name: string
  depth: number
  tideDependent: boolean
}

function findSafeRoute(passages: Passage[]): Passage | null {
  return passages.find(p => !p.tideDependent && p.depth < 100) ?? null
}
\`\`\`

##### Footnotes

The margins contained tiny annotations in a hand she didn't recognize.

###### Appendix Reference

See the [Archive Index](https://example.com/archive) for the full catalogue.

![Map of the passages](https://picsum.photos/seed/meridian/600/300)

The clock on the wall struck three. She was already late.
`

/** Short chapter for quick demos */
export const shortChapter = `# Chapter 12: The Brass Door

Mara paused with her hand above the latch, listening to the building breathe.

The corridor smelled of rain and old varnish. She could hear the clock tower three streets over, its **deep** voice counting midnight.

> "You can keep a secret or keep your sleep. You rarely keep both."

The note had ended there.
`

/** Character sheet */
export const characterSheet = `# Elena Vasquez

**Age:** 27 | **Role:** Navigator | **Affiliation:** The Meridian Society

## Appearance

Dark hair cut short. A thin scar runs from her left temple to her jaw — she tells people it was a sailing accident, but the angle is wrong for that.

## Abilities

- *Tidewalking* — can sense the movement of underground waterways
- *Pattern sight* — recognizes hidden structure in maps and charts
- Navigation under starless skies

## Key Relationships

1. **Mara** — childhood friend, now estranged
2. **The Cartographer** — mentor, missing since the solstice
3. **Finn** — her ship's engineer, loyal but skeptical

> "She doesn't trust easily. But once she does, she trusts completely."
> — Mara's journal, entry 42
`

/** Worldbuilding document */
export const worldbuildingNotes = `# World Rules: The Tidelands

## Magic System

Magic in the Tidelands follows the movement of water. Power flows with the tides — strongest at high tide, weakest at low.

### Core Principles

- Magic is **not** inherited — it must be *learned*
- Every spell requires a \`resonance anchor\` (a physical object attuned to the caster)
- Overuse causes \`tide sickness\` — disorientation, memory gaps, synesthesia

### Tide Categories

| Tide Level | Power Available | Risk Level |
|------------|----------------|------------|
| High       | Maximum        | High       |
| Mid        | Moderate       | Low        |
| Low        | Minimal        | None       |
| Neap       | Unpredictable  | Extreme    |

## Geography

The Tidelands are an archipelago of 47 islands connected by underwater passages that flood and drain with the tides.

![Tidelands overview](https://picsum.photos/seed/tidelands/600/300)

---

## Factions

1. **The Meridian Society** — cartographers and navigators
2. **The Bellkeepers** — timekeepers who track tide cycles
3. **The Riven** — outcasts who channel magic during neap tides
`

/** Collaboration demo initial content */
export const collabDocument = `# The Shared Manuscript

The story was being written by two hands now.

Elara had started the first draft alone, sitting in the cartographer's study with a cup of cold tea and a pen that leaked. But when Mara arrived — unexpected, unannounced — she pulled up a chair and began adding to the margins.

They wrote in different colors: Elara in black, Mara in blue. The narrative forked and merged like a river delta.

> "Two writers, one story. The trick is knowing when to lead and when to follow."

---

Type below to see real-time collaboration in action.
`

/** Interaction demo content with all clickable element types */
export const interactionContent = `# Interaction Demo

Here is a [link to the Archive](https://example.com/archive). Try Cmd+Click to open it.

![A landscape painting](https://picsum.photos/seed/demo/400/200)

\`\`\`python
def greet(name: str) -> str:
    """Greet a fellow cartographer."""
    return f"Welcome to the Meridian, {name}!"

print(greet("Elena"))
\`\`\`

Try these interactions on the elements above:
- **Double-click** on the link, image, or code block to edit
- **Right-click** for the context menu
- **Hover** over elements to see edit affordances
- **Cmd+B** to toggle bold, **Cmd+I** for italic, **Cmd+K** for link
`
