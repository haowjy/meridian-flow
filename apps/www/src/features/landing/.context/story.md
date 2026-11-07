# The landing page story

The scroll film shows a writer and a team of agents writing the Prologue of a
fictional serial, *The Long Reckoning*, in a drawing of the app. This page is the
story's canon: what is settled, what the page's impact depends on, what is still
open, and the ideas already tried and dropped. Read it before changing any of the
page's story copy.

[`story.ts`](../story.ts) holds every word the page shows: the four character
pages with their Writer's notes, the world and place pages, the Prologue lines,
the card's question, the System boxes, the end screen and the section
headings. Facts in it are canon. [`prologue.md`](prologue.md) is the Prologue the page excerpts. Where
the two differ, `story.ts` is what ships; bring the prose in line.

## Premise

The serial is LitRPG with a time loop, written for Royal Road and web serial
readers, who know the genre's tropes and reward a familiar setup with a real
turn.

The Cold Fire came over the north on a clear night in spring. It is the breath
of a beast in the ice, and it spreads a little further south each night while
the sun comes up colder. The four peoples sent armies north first; none came
back. Then each people sent its strongest, and those four are the party.

On the ninth night they find the beast, and it is a dragon. They hurt it, and
it kills three of them. Over the last one standing, a blue System box opens,
the death box. Its text, "You died.", is `SYSTEM.death` in `story.ts`. The
dragon eats light, so it turns to the box, the brightest thing on the ice, and
breathes on it, burning the box and the survivor. The survivor wakes
where they stood on the first night of the Cold Fire, with the unique skill
Rekindle.

The page aims for impact, not a twist. To this audience a dragon at the end of
the road and a death loop are both familiar, so neither surprises, and no beat
should be written to. What lands is the cost: the visitor meets the four at the
campfire, watches three of them die, picks the survivor, and reads that
survivor's last words. The Rekindle button lets the visitor loop it themselves,
and every pick leaves three others dead.

## The loop

- The survivor wakes on the first night of the Cold Fire, about forty days
  before the ninth night. The Prologue's dates set the span: barley stops by
  the tenth day, the armies go and vanish, then the four walk nine days north
  from the last Kessa camp.
- Memory and what the survivor has learned to do carry over. Levels reset.
- Everyone else is alive again and has never met the survivor. Only the
  survivor remembers. The beast doesn't remember either, which makes it
  learnable.
- The loop ends when the beast dies. The loop count is unlimited and never
  shown.
- Rekindle is unique: nobody else has it. A loop power every System user had would take
  away what makes the survivor special.

## The four

Any of the four can be the survivor. Each has a reason to live and a different
book after the Prologue, so the card has no right answer and marks none as
recommended. The shared text is told as "we" and names no narrator, because the visitor
hasn't picked yet; each ending switches to the survivor's "I".

| | People | Skill | Physical detail |
|---|---|---|---|
| Tam | Human, Harl, 17 | `[Spark]` | Burn scars from his right hand to the elbow |
| Sigrun | Dwarf, Ansgard, 140 | `[Ward Rune]` | Ward runes cut down both forearms |
| Maren | Elf, Vell, 1,040 | `[Mending Hymn]` | Blind since she was six |
| Oskar | Beastkin (bear-blooded), the Kessa steppe, 38 | `[Sense Fear]` | Half his left ear gone |

The pages carry the film's continuity catch: Tam's page says his spark won't catch
in deep cold, the Continuity-checker finds the draft putting one in the dragon's
eye anyway, and Muse fixes it with Sigrun's ward, which warms the air it shields. Each of the four keeps a secret in their Writer's notes in
`story.ts`; the survivor learns them by reliving the nine days.

Each survivor's last line on the page is their reaction to dying, typed before
anyone knows about the loop. It never introduces the speaker: nobody dying
says who they are. It answers the survivor's card pitch, the only thing the
visitor has read about them, because on the page it follows straight after
"You died.": a line that leans on the full Prologue (the song, the field)
means nothing there.

## World the page establishes

- **The System** has always existed. Everyone has a level, skills and a tag;
  blue boxes announce them, read aloud to anyone who can't see. It has never
  told anyone what to do or talked like a game, so the death box is the first
  of its kind. Something has taken hold of the System: it wrote that box, and it
  wants the beast dead.
- **The beast** has no tag and no level: the System doesn't see it. Its breath
  is the Cold Fire. Only the Kessa song says dragons exist, and everyone else
  calls it a myth.
- **The road north** runs Harl, Ansgard, Vell, the Kessa steppe, then the ice
  the Kessa call the Greenlands. Tam comes from the furthest south, which is
  why the others join one at a time.
- **The first armies** sit frozen in the snow five days north of the last Kessa
  camp, still listed by the System as *Missing*.

## How it plays on the page

The beats are in [`timeline.ts`](../timeline.ts). In story order:

1. The campfire: the four sit at the fire and the System opens a status window
   over each, `SHEETS` in `story.ts`: who they are, their skill and what it
   does. It is the visitor's only meeting with them before three die, and it sets up the fight: Tam's spark won't catch in deep cold,
   and a ward turns one blow.
2. The turn line: "On the ninth night, we found it. It was a dragon."
3. The fight: the ward splits the first breath, they hurt it, and three fall.
   Once the breath reaches them, all four char to the same plain silhouette and
   one comes out of the fire still standing, so nobody can tell who fell or who
   stands: the visitor hasn't said who survives. Who
   does what, and when, is `FIGHT` in `timeline.ts`; nobody carries a bow.
4. The death box opens over the last one standing, and the dragon's fire
   burns it away, revealing the app. In the Knowledge Base, The Beast becomes
   The Dragon once the scene says what it is.
5. The card asks who survives. It always arrives empty, never preselected.
   Skipping it, or scrolling past it, has the System assign one of the four at
   random: `[No selection. Survivor assigned: …]`. Every path has one survivor.
6. The survivor's last line types into the manuscript, after the death box's
   line.
7. The Rekindle box: `[Unique skill acquired: Rekindle]`, with a **Rekindle**
   button that returns to the cliff scene and resets the card, so the visitor can loop and pick someone else.
8. The end question: "What will you write?", with an input for the visitor's
   own book and Start writing.

The fake Knowledge Base rail follows the app's real folder tree: Manuscript
with the Prologue, then the Knowledge Base with Characters, World (with Places
inside it) and Vocab. The Vocab page there spells each story term one way; follow it in
any new copy.

## Rejected

- **Condemned criminals** as the four. They are heroes.
- **Building a beat as a twist.** The dragon and the death box are both
  expected by this audience, so a beat written to surprise them lands flat.
- **"We had to fight a dragon." as the burning line.** The System box burns
  instead of a headline.
- **`Status: Alive` on the campfire sheets.** Four Alive lines before the boss
  read as a promise they will change, so the visitor knows three die screens
  early.
- **A `Source` line on a skill,** such as `[Source: unknown]` under Rekindle.
  Nothing on the page says what a source is, so the label carried no weight and
  only made the sheets and the box harder to read.
- **Everyone rising undead when the visitor skips.** A skip assigns a survivor.
- **"Tutorial complete." as the death box's text.** Halfway down a landing
  page it reads as the page's own walkthrough ending.
- **A loop counter, or "Survivors: 1/4"** in any box. The loop is unlimited and
  uncounted.
- **Ending on "Chapter 1: ____".** The end asks what book the visitor wants to
  write.
- **A Series Bible or Spoilers page in the Knowledge Base.** The Knowledge Base
  is the series bible, and each secret lives in the Writer's notes of the page
  it is about.
- **The other full-story concepts:** a world without magic where dragons were
  extinct, a Demon King legend hiding a tithe, a dragon guarding a clutch, a
  dragon whose fire the old heroes stole, and a dragon civilisation carrying a
  warning. This story replaced them, and with them the versions where the System is new
  to the world or new to the survivor.

## Open

- Who or what took hold of the System, and why it needs the beast dead.
- What the System says when the beast dies.
- Why the System can't see the beast.
- Whether the beast has woken before.
- The names Tam, Maren, Sigrun and Oskar are working names.
- The title, *The Long Reckoning*.
