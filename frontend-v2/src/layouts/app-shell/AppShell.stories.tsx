import type { Meta, StoryObj } from "@storybook/react-vite"

import { DEMO_DOCUMENT_PATH, DEMO_THREAD_ID } from "../shared/mock-data"
import { AppRouterStory } from "./app-router-story"
import { AppShell } from "./AppShell"

const meta = {
  title: "Layouts/AppShell",
  component: AppShell,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AppShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="h-dvh w-screen">
      <AppRouterStory
        initialPath={`/projects/demo/converse/${DEMO_THREAD_ID}`}
      />
    </div>
  ),
}

export const AgentsMode: Story = {
  render: () => (
    <div className="h-dvh w-screen">
      <AppRouterStory initialPath="/projects/demo/agents" />
    </div>
  ),
}

export const StudioMode: Story = {
  render: () => (
    <div className="h-dvh w-screen">
      <AppRouterStory
        initialPath={`/projects/demo/studio/${encodeURIComponent(DEMO_DOCUMENT_PATH)}`}
      />
    </div>
  ),
}
