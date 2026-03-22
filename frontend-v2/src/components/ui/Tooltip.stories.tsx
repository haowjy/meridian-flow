import type { Meta, StoryObj } from "@storybook/react-vite"
import { Info, PencilSimple, TrashSimple } from "@phosphor-icons/react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"
import { Button } from "./button"

const meta = {
  title: "UI/Tooltip",
  component: Tooltip,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover me</Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>This is a tooltip</p>
      </TooltipContent>
    </Tooltip>
  ),
}

export const Placements: Story = {
  render: () => (
    <div className="flex items-center justify-center gap-4 py-12">
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <Tooltip key={side}>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm">
              {side}
            </Button>
          </TooltipTrigger>
          <TooltipContent side={side}>
            <p>Tooltip on {side}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  ),
}

export const OnIconButton: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Info">
            <Info className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>View information</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Edit">
            <PencilSimple className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Edit chapter</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Delete">
            <TrashSimple className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Delete chapter</p>
        </TooltipContent>
      </Tooltip>
    </div>
  ),
}
