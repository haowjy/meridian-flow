import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState, type ComponentProps } from "react"

import { TabBar, type TabBarTab } from "./tab-bar"

const SAMPLE_TABS: TabBarTab[] = [
  { id: "1", label: "chapter-28.md", isDirty: true },
  { id: "2", label: "outline.md" },
  { id: "3", label: "notes-review.md", isPreview: true },
  { id: "4", label: "characters.md" },
  { id: "5", label: "timeline.md" },
  { id: "6", label: "world-bible.md" },
  { id: "7", label: "draft-v3.md", isDirty: true },
]

const meta = {
  title: "UI/TabBar",
  component: TabBar,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof TabBar>

export default meta
type Story = StoryObj<typeof meta>

/** Satisfies Storybook required-args when stories use custom `render`. */
const tabBarStoryArgs = {
  tabs: [],
  activeTabId: null,
  onTabActivate: () => undefined,
  onTabClose: () => undefined,
} satisfies ComponentProps<typeof TabBar>

function TabBarDemo({
  tabs = SAMPLE_TABS,
  showOverflow = false,
}: {
  tabs?: TabBarTab[]
  showOverflow?: boolean
}) {
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? "")
  const [items, setItems] = useState(tabs)

  return (
    <TabBar
      tabs={items}
      activeTabId={activeId}
      showOverflowIndicator={showOverflow}
      onTabActivate={setActiveId}
      onTabClose={(id) => {
        const next = items.filter((t) => t.id !== id)
        setItems(next)
        if (activeId === id) setActiveId(next[0]?.id ?? "")
      }}
      onTabPromote={(id) =>
        setItems((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, isPreview: false, isDirty: t.isDirty } : t,
          ),
        )
      }
      onTabPin={(id) =>
        setItems((prev) =>
          prev.map((t) => (t.id === id ? { ...t, isPreview: false } : t)),
        )
      }
    />
  )
}

export const Default: Story = {
  args: tabBarStoryArgs,
  render: () => <TabBarDemo tabs={SAMPLE_TABS.slice(0, 4)} />,
}

export const ActivePersistent: Story = {
  args: tabBarStoryArgs,
  render: () => (
    <TabBar
      tabs={[{ id: "1", label: "chapter-28.md", isDirty: true }]}
      activeTabId="1"
      onTabActivate={() => undefined}
      onTabClose={() => undefined}
    />
  ),
}

export const ActivePreview: Story = {
  args: tabBarStoryArgs,
  render: () => (
    <TabBar
      tabs={[{ id: "1", label: "notes-review.md", isPreview: true }]}
      activeTabId="1"
      onTabActivate={() => undefined}
      onTabClose={() => undefined}
    />
  ),
}

export const DirtyAndPreview: Story = {
  args: tabBarStoryArgs,
  render: () => <TabBarDemo />,
}

export const Overflow: Story = {
  args: tabBarStoryArgs,
  render: () => (
    <div className="max-w-md border border-border">
      <TabBarDemo showOverflow />
    </div>
  ),
}
