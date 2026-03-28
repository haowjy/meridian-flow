/**
 * Live preview stories — complex decoration types worth isolating.
 *
 * Simple elements (headings, bold, italic, links, inline code, horizontal
 * rules, blockquotes) are all exercised in the FullDocument story.
 * Individual stories exist only for elements with complex rendering
 * behavior worth debugging in isolation.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { StandaloneEditor } from "./helpers/StandaloneEditor"
import {
  fullDocument,
  characterSheet,
  worldbuildingNotes,
} from "./helpers/mockContent"

const meta = {
  title: "Editor/LivePreview",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta
type Story = StoryObj

// --- Complex rendering (worth isolating for debugging) ---

export const Images: Story = {
  render: () => (
    <StandaloneEditor
      initialContent={`![Rain over harbor](https://picsum.photos/seed/harbor/600/300)

The tide pulled the piers into shadow.

![Mountain pass at dawn](https://picsum.photos/seed/mountain/600/300)

The path narrowed between the ridges.`}
      livePreview
    />
  ),
}

export const CodeBlocks: Story = {
  render: () => (
    <StandaloneEditor
      initialContent={`Inline detail: \`clockwork\`.

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

And a Python block:

\`\`\`python
def chart_tides(day: int) -> list[float]:
    """Calculate tide heights for a given day."""
    return [2.1 * sin(pi * h / 12) for h in range(24)]
\`\`\`

An unlabeled block:

\`\`\`
Entry 114: The tides shifted again.
The old channels are silting up.
New routes must be charted before winter.
\`\`\``}
      livePreview
    />
  ),
}

export const MermaidDiagrams: Story = {
  render: () => (
    <StandaloneEditor
      initialContent={`# Passage Network

\`\`\`mermaid
flowchart TD
    A[Meridian Gate] --> B{Fork}
    B -->|Left| C[River Passage]
    B -->|Right| D[Cartographer's Study]
    C --> E[Tidewater Basin]
    D --> F[Archive]
    F --> G[The Deep Library]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    participant E as Elara
    participant M as Mara
    participant C as Cartographer
    E->>C: Request passage map
    C-->>E: Map with annotations
    E->>M: Share findings
    M-->>E: Corrections noted
\`\`\``}
      livePreview
    />
  ),
}

export const Lists: Story = {
  render: () => (
    <StandaloneEditor
      initialContent={`She carried three things:

- A compass that pointed to yesterday
  - Its needle was made of condensed moonlight
  - The casing was scratched but functional
- A letter sealed with black wax
- A name she wasn't supposed to know

Her instructions were precise:

1. Cross the threshold before the third bell
2. Find the cartographer's study
   1. Check the desk drawers first
   2. Then the hidden shelf
3. Do not look at the river`}
      livePreview
    />
  ),
}

// --- Full documents (realistic content) ---

export const FullDocument: Story = {
  name: "Full Document (All Elements)",
  render: () => (
    <StandaloneEditor
      initialContent={fullDocument}
      livePreview
    />
  ),
}

export const CharacterSheet: Story = {
  render: () => (
    <StandaloneEditor
      initialContent={characterSheet}
      livePreview
    />
  ),
}

export const WorldbuildingNotes: Story = {
  render: () => (
    <StandaloneEditor
      initialContent={worldbuildingNotes}
      livePreview
    />
  ),
}
