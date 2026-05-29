import type { Meta, StoryObj } from "@storybook/react-vite"

import { ShellVisibilityProvider } from "../app-shell/shell-visibility-context"
import { AgentsShell } from "./AgentsShell"

const meta = {
  title: "Layouts/AgentsShell",
  component: AgentsShell,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <ShellVisibilityProvider activeMode="agents">
        <div className="h-dvh w-screen">
          <Story />
        </div>
      </ShellVisibilityProvider>
    ),
  ],
} satisfies Meta<typeof AgentsShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
