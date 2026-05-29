import type { Meta, StoryObj } from "@storybook/react-vite"

import { WorkItemCard } from "./work-item-card"

const meta = {
  title: "UI/WorkItemCard",
  component: WorkItemCard,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkItemCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    title: "Arc 4 — Storm Court revision",
    status: "active",
    threadCount: 3,
    lastActivity: "2 hours ago",
  },
}

export const Selected: Story = {
  args: {
    ...Default.args,
    selected: true,
  },
}

export const Idle: Story = {
  args: {
    title: "Character bible refresh",
    status: "idle",
    threadCount: 1,
    lastActivity: "Yesterday",
  },
}

export const Completed: Story = {
  args: {
    title: "Chapter 27 proof pass",
    status: "completed",
    threadCount: 0,
    lastActivity: "3 days ago",
  },
}

export const Error: Story = {
  args: {
    title: "Timeline consistency check",
    status: "error",
    threadCount: 2,
    lastActivity: "Failed 10 min ago",
  },
}

export const Loading: Story = {
  args: {
    title: "",
    status: "idle",
    threadCount: 0,
    lastActivity: "",
    loading: true,
  },
}

export const DashboardList: Story = {
  args: {
    title: "",
    status: "idle",
    threadCount: 0,
    lastActivity: "",
  },
  render: () => (
    <ul className="flex flex-col gap-3">
      <li>
        <WorkItemCard
          selected
          title="Arc 4 — Storm Court revision"
          status="active"
          threadCount={3}
          lastActivity="2 hours ago"
        />
      </li>
      <li>
        <WorkItemCard
          title="Character bible refresh"
          status="idle"
          threadCount={1}
          lastActivity="Yesterday"
        />
      </li>
      <li>
        <WorkItemCard
          title="Chapter 27 proof pass"
          status="completed"
          threadCount={0}
          lastActivity="3 days ago"
        />
      </li>
    </ul>
  ),
}
