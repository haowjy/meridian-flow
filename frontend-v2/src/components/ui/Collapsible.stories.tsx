import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "./button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"

const meta = {
  title: "UI/Collapsible",
  component: Collapsible,
  tags: ["autodocs"],
} satisfies Meta<typeof Collapsible>

export default meta
type Story = StoryObj<typeof meta>

export const DefaultOpen: Story = {
  render: () => (
    <Collapsible defaultOpen className="w-full max-w-xl space-y-2">
      <CollapsibleTrigger asChild>
        <Button variant="outline">Toggle Character Notes</Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
        Kael&apos;s vow in Chapter 9 must conflict with his choice in Chapter 21.
      </CollapsibleContent>
    </Collapsible>
  ),
}
