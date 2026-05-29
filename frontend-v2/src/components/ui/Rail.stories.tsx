import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState, type ComponentProps } from "react"

import { Rail, type AppMode } from "./rail"

const meta = {
  title: "UI/Rail",
  component: Rail,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="flex h-dvh bg-background">
        <Story />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Shell content area
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof Rail>

export default meta
type Story = StoryObj<typeof meta>

/** Satisfies Storybook required-args when stories use custom `render`. */
const railStoryArgs = {
  activeMode: "studio",
  onModeChange: () => undefined,
} satisfies ComponentProps<typeof Rail>

function RailDemo({
  initialMode = "studio" as AppMode,
  showSettings = true,
}: {
  initialMode?: AppMode
  showSettings?: boolean
}) {
  const [mode, setMode] = useState<AppMode>(initialMode)
  return (
    <Rail
      activeMode={mode}
      onModeChange={setMode}
      onOpenSettings={showSettings ? () => {} : undefined}
    />
  )
}

export const Default: Story = {
  args: railStoryArgs,
  render: () => <RailDemo />,
}

export const AgentsActive: Story = {
  args: railStoryArgs,
  render: () => <RailDemo initialMode="agents" />,
}

export const WithoutSettings: Story = {
  args: railStoryArgs,
  render: () => <RailDemo showSettings={false} />,
}
