import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileText } from "@phosphor-icons/react"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

const meta = {
  title: "UI/Popover",
  component: Popover,
  tags: ["autodocs"],
} satisfies Meta<typeof Popover>

export default meta
type Story = StoryObj<typeof meta>

export const WikiLink: Story = {
  render: () => (
    <p className="max-w-xl font-editor text-base leading-relaxed">
      The jade peaks blazed with inner fire as Kael approached the monastery.
      He recalled everything from{" "}
      <Popover>
        <PopoverTrigger asChild>
          <button className="inline cursor-pointer rounded-sm bg-muted px-1 py-px text-accent-text underline decoration-dotted underline-offset-2 hover:bg-accent">
            [[Chapter 3 — The Awakening]]
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Chapter 3 — The Awakening</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Kael discovers the jade resonance during a thunderstorm. First
              appearance of Elder Mei. 2,847 words.
            </p>
            <p className="text-xs text-muted-foreground">
              Last edited 2 hours ago
            </p>
          </div>
        </PopoverContent>
      </Popover>
      , especially the moment the jade resonance first surged through his
      meridians.
    </p>
  ),
}

export const CharacterReference: Story = {
  render: () => (
    <p className="max-w-xl font-editor text-base leading-relaxed">
      Elder Mei had warned her about the cost, but{" "}
      <Popover>
        <PopoverTrigger asChild>
          <button className="inline cursor-pointer rounded-sm bg-muted px-1 py-px text-accent-text underline decoration-dotted underline-offset-2 hover:bg-accent">
            [[Eira Vale]]
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="space-y-2">
            <p className="text-sm font-semibold">Eira Vale</p>
            <p className="text-sm text-muted-foreground">
              Archivist with a hidden pact. First appears in Chapter 3. Ally to
              Kael, secretly bound to the Obsidian Court.
            </p>
            <dl className="space-y-1 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <dt>Appearances</dt>
                <dd className="font-medium">12 chapters</dd>
              </div>
              <div className="flex justify-between">
                <dt>Arc</dt>
                <dd className="font-medium">Betrayal &rarr; Redemption</dd>
              </div>
            </dl>
          </div>
        </PopoverContent>
      </Popover>{" "}
      pressed forward anyway, her fingers tracing the seal on the archive door.
    </p>
  ),
}

export const SceneStats: Story = {
  render: () => (
    <p className="max-w-xl font-editor text-base leading-relaxed">
      The battle scene in{" "}
      <Popover>
        <PopoverTrigger asChild>
          <button className="inline cursor-pointer rounded-sm bg-muted px-1 py-px text-accent-text underline decoration-dotted underline-offset-2 hover:bg-accent">
            [[Chapter 12 — The Siege]]
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Chapter 12 — The Siege</p>
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Words</dt>
                <dd className="font-medium">4,231</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Dialogue</dt>
                <dd className="font-medium">24%</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Read time</dt>
                <dd className="font-medium">17 min</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Status</dt>
                <dd className="font-medium text-muted-foreground">Draft</dd>
              </div>
            </dl>
          </div>
        </PopoverContent>
      </Popover>{" "}
      needed more visceral detail.
    </p>
  ),
}
