import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "./button"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

const meta = {
  title: "UI/Popover",
  component: Popover,
  tags: ["autodocs"],
} satisfies Meta<typeof Popover>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Open Popover</Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="space-y-2">
          <p className="text-sm font-medium">Popover Content</p>
          <p className="text-sm text-muted-foreground">
            This is a basic popover with some content inside.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  ),
}

export const Placements: Story = {
  render: () => (
    <div className="flex items-center justify-center gap-4 py-20">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">Top</Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-48">
          <p className="text-sm text-muted-foreground">Placed above the trigger.</p>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">Bottom</Button>
        </PopoverTrigger>
        <PopoverContent side="bottom" className="w-48">
          <p className="text-sm text-muted-foreground">Placed below the trigger.</p>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">Left</Button>
        </PopoverTrigger>
        <PopoverContent side="left" className="w-48">
          <p className="text-sm text-muted-foreground">Placed left of the trigger.</p>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">Right</Button>
        </PopoverTrigger>
        <PopoverContent side="right" className="w-48">
          <p className="text-sm text-muted-foreground">Placed right of the trigger.</p>
        </PopoverContent>
      </Popover>
    </div>
  ),
}
