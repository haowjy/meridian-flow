import type { Meta, StoryObj } from "@storybook/react-vite"
import { Columns, ListBullets, Rows } from "@phosphor-icons/react"
import { ToggleGroup, ToggleGroupItem } from "./toggle-group"

const meta = {
  title: "UI/ToggleGroup",
  component: ToggleGroup,
  tags: ["autodocs"],
} satisfies Meta<typeof ToggleGroup>

export default meta
type Story = StoryObj<typeof meta>

export const SingleSelect: Story = {
  args: {
    type: "single",
  },
  render: () => (
    <ToggleGroup type="single" defaultValue="split" aria-label="Editor layout">
      <ToggleGroupItem value="list" aria-label="List layout">
        <ListBullets className="size-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="split" aria-label="Split layout">
        <Columns className="size-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="focus" aria-label="Focus layout">
        <Rows className="size-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
}

export const MultiSelect: Story = {
  args: {
    type: "multiple",
  },
  render: () => (
    <ToggleGroup type="multiple" defaultValue={["word-count", "line-numbers"]} aria-label="Editor tools">
      <ToggleGroupItem value="word-count">Word Count</ToggleGroupItem>
      <ToggleGroupItem value="line-numbers">Line Numbers</ToggleGroupItem>
      <ToggleGroupItem value="minimap">Minimap</ToggleGroupItem>
    </ToggleGroup>
  ),
}

export const OutlineVariant: Story = {
  args: {
    type: "single",
  },
  render: () => (
    <ToggleGroup type="single" variant="outline" defaultValue="chapter" aria-label="View mode">
      <ToggleGroupItem value="chapter">Chapter</ToggleGroupItem>
      <ToggleGroupItem value="scene">Scene</ToggleGroupItem>
      <ToggleGroupItem value="timeline">Timeline</ToggleGroupItem>
    </ToggleGroup>
  ),
}
