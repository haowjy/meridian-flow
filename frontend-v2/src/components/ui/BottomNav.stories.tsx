import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState, type ComponentProps } from "react"

import { BottomNav, type BottomNavTab } from "./bottom-nav"

const meta = {
  title: "UI/BottomNav",
  component: BottomNav,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="relative h-dvh bg-background">
        <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
          Phone / tablet portrait shell
        </div>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BottomNav>

export default meta
type Story = StoryObj<typeof meta>

/** Satisfies Storybook required-args when stories use custom `render`. */
const bottomNavStoryArgs = {
  activeTab: "converse",
  onTabChange: () => undefined,
} satisfies ComponentProps<typeof BottomNav>

function BottomNavDemo({
  initialTab = "converse" as BottomNavTab,
  showMoreAlert = false,
}: {
  initialTab?: BottomNavTab
  showMoreAlert?: boolean
}) {
  const [tab, setTab] = useState<BottomNavTab>(initialTab)
  return (
    <BottomNav
      activeTab={tab}
      onTabChange={setTab}
      showMoreAlert={showMoreAlert}
    />
  )
}

export const Default: Story = {
  args: bottomNavStoryArgs,
  render: () => <BottomNavDemo />,
}

export const StudioActive: Story = {
  args: bottomNavStoryArgs,
  render: () => <BottomNavDemo initialTab="studio" />,
}

export const MoreWithConnectionAlert: Story = {
  args: bottomNavStoryArgs,
  render: () => (
    <BottomNavDemo initialTab="more" showMoreAlert />
  ),
}
