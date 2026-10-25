/** Authored fiction-workflow samples, not recordings or responses to the current prompt. */
import type { MockModelDefaultResponse } from "@meridian/contracts/protocol";

type SampleName = NonNullable<MockModelDefaultResponse["sample"]>;

export const MOCK_SAMPLES: Record<SampleName, { reasoning: string; text: string }> = {
  scene: {
    reasoning:
      "The scene needs a concrete objective, an obstacle, and a choice that costs something. I'll keep the viewpoint close to Mei, reveal the cultivation rule through action, and end on a consequence rather than an explanation.",
    text: `## The bell beneath the mountain

Mei reached the ninth stair before the bell rang beneath her feet.

Not above her, where the temple hung between two cliffs. Beneath her. The sound travelled up through the jade soles of her borrowed shoes and settled behind her teeth.

She stopped breathing. The old gatekeeper had been very specific about that part.

*When the mountain speaks, do not answer it.*

Three stairs ahead, Jun turned. His left sleeve was dark with rain, his right with something thicker. He pointed toward the gate without looking at the stone beneath her.

"Keep moving."

Mei shook her head.

A hairline crack opened across the stair. Through it shone the warm orange light of a kitchen fire. She smelled ginger, then scorched rice. Her mother's voice called her childhood name.

Jun came back down one step.

"That isn't her."

Of course it wasn't. Her mother had never burned rice.

Mei pressed two fingers against the copper coin at her throat. One breath of qi remained inside it. Enough to cross the gate. Enough to hold the crack shut while Jun crossed instead.

The mountain called again, this time in Jun's voice.

She broke the coin.

Light ran into the stair. The crack closed with a sound like a cup being set carefully on a table. Above her, the temple gate opened, and Jun stumbled through.

For the first time in seven hundred years, the mountain fell silent.

Then something on the other side knocked.`,
  },
  critique: {
    reasoning:
      "I'll separate the scene's working tension from the revision opportunities. The useful feedback should point to a specific sentence or beat, explain its effect, and offer a small revision without flattening the voice.",
    text: `## What is working

The borrowed shoes and the almost-empty copper coin establish Mei's position without a paragraph of backstory. Her final choice uses something the reader already understands.

The strongest detail is **the scorched rice**. It lets Mei recognize the deception herself, so Jun's warning does not solve the problem for her.

## Two revisions to try

1. **Make the deadline visible.** Let rainwater carry blood from Jun's sleeve toward the crack. Mei can watch the distance shrink while she decides.
2. **Give the sacrifice an immediate physical cost.** After she breaks the coin, her borrowed shoes might become too heavy to lift. That makes the lost qi tangible before the next chapter explains it.

### A tighter exchange

> "That isn't her."
>
> Mei knew. Her mother had never burned rice.
>
> Knowing did not make the voice easier to leave.

Keep the final knock. It turns a successful rescue into a new problem without undoing Mei's choice.`,
  },
  outline: {
    reasoning:
      "Each chapter should change what Mei can do or what she believes, not merely postpone the same confrontation. I'll connect the progression reward to the cost of her earlier choice and give the supporting character an independent objective.",
    text: `## Three-chapter progression arc

### Chapter 1: A debt in copper

- **Goal:** Enter the outer sect before the examination closes.
- **Obstacle:** The mountain offers a shortcut in a familiar voice.
- **Choice:** Mei spends her last stored breath rescuing Jun.
- **Turn:** She misses admission but becomes the only person who can hear the sealed door.

### Chapter 2: The silent technique

- **Goal:** Earn a place without passing the qi measurement.
- **Obstacle:** Every conventional technique makes the knocking louder.
- **Discovery:** Her empty coin can absorb a sound instead of storing a breath.
- **Cost:** Each use erases a small auditory memory. She records her mother's song before practising again.

### Chapter 3: Someone answers

- **Goal:** Stop a senior disciple from opening the door.
- **Complication:** Jun wants it opened because his brother is on the other side.
- **Payoff:** Mei uses the examination bell to interrupt the ritual, demonstrating her technique before the whole sect.
- **Hook:** The voice behind the door knows a verse of the song she never wrote down.

## Continuity checks

- The copper coin breaks before the technique is discovered.
- Jun owes Mei his life but does not owe her agreement.
- Power solves the immediate problem and creates a cost that survives the chapter.`,
  },
  markdown: {
    reasoning:
      "This sample exercises common answer formatting, nested lists, quotations, code fences, links, and multilingual text. These are rendered text formats, not additional provider block types.",
    text: `# Scene planning notes

A **clear objective** gives the action direction. An *unspoken fear* gives the same action a second meaning.

## Revision checklist

- Establish the viewpoint character's immediate goal.
  - Name what they can touch or change.
  - Put the obstacle in the same physical space.
- Track the resource they cannot replace.
- End after the choice has a consequence.

> The gate opened. Mei stayed on the wrong side.

### Continuity data

\`\`\`json
{
  "character": "Mei",
  "qiReserves": 0,
  "inventory": ["broken copper coin", "borrowed jade shoes"],
  "promise": "Bring Jun home"
}
\`\`\`

Use \`qiReserves\` consistently in the outline. A literal <gate> is not an HTML element in the manuscript.

### Language and punctuation

“别回头。” Mei did not turn around. The inscription read 山门. A margin note contained an emoji: 🐉.

For another formatting reference, see the [CommonMark specification](https://spec.commonmark.org/).

---

The next scene begins with a decision, not a recap.`,
  },
};
