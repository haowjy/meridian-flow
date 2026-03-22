import type { Meta, StoryObj } from "@storybook/react-vite"
import { ScrollArea, ScrollBar } from "./scroll-area"

const chapters = Array.from({ length: 24 }, (_, index) => ({
  id: index + 1,
  title: `Chapter ${index + 1}: Emberline ${index % 2 === 0 ? "Rises" : "Falls"}`,
  words: 1800 + index * 75,
}))

const meta = {
  title: "UI/ScrollArea",
  component: ScrollArea,
  tags: ["autodocs"],
} satisfies Meta<typeof ScrollArea>

export default meta
type Story = StoryObj<typeof meta>

export const VerticalList: Story = {
  render: () => (
    <ScrollArea className="h-72 w-full max-w-md rounded-md border">
      <div className="p-4">
        <h4 className="mb-3 text-sm font-medium">Manuscript Chapters</h4>
        <div className="space-y-2">
          {chapters.map((chapter) => (
            <div key={chapter.id} className="rounded-md border bg-card p-3">
              <p className="text-sm font-medium">{chapter.title}</p>
              <p className="text-xs text-muted-foreground">{chapter.words} words</p>
            </div>
          ))}
        </div>
      </div>
    </ScrollArea>
  ),
}

export const HorizontalTags: Story = {
  render: () => (
    <ScrollArea orientation="horizontal" className="w-full max-w-xl rounded-md border whitespace-nowrap">
      <div className="flex w-max gap-3 p-4">
        {[
          "POV: Mira",
          "Setting: Observatory",
          "Conflict: Trust",
          "Arc: Storm Court",
          "Tone: Tense",
          "Needs Rewrite",
          "Publish Queue",
        ].map((tag) => (
          <span
            key={tag}
            className="inline-flex h-11 items-center rounded-md border bg-card px-4 text-sm"
          >
            {tag}
          </span>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
}
